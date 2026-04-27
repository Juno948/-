import { useState, useRef, useCallback, useEffect } from "react";

// localStorage adapter (mirrors window.storage API used in Claude artifacts)
window.storage = {
  get: async (key) => {
    try {
      const val = localStorage.getItem(key);
      if (val === null) throw new Error("not found");
      return { key, value: val };
    } catch(e) { throw e; }
  },
  set: async (key, value) => {
    localStorage.setItem(key, value);
    return { key, value };
  },
  delete: async (key) => {
    localStorage.removeItem(key);
    return { key, deleted: true };
  }
};



const C = {
  bg: "#0f0f0f", surface: "#1a1a1a", card: "#222222", border: "#2e2e2e",
  accent: "#c8f542", accentDim: "#a8d030", text: "#f0f0f0", muted: "#888",
  danger: "#ff5252", blue: "#64b5f6", orange: "#ffb74d", red: "#ef5350",
  purple: "#b39ddb", green: "#81c784",
};

const FOOD_KEY    = "calorie-history";
const WORKOUT_KEY = "workout-history";
const MAX_RECORDS = 60;
const DAILY_GOAL  = 1820;

const toDateKey = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,"0")}.${String(d.getDate()).padStart(2,"0")}`;
};
const todayKey = toDateKey(new Date().toISOString());

const formatTime = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
};
const formatDateLabel = (key) => {
  if (key === todayKey) return "오늘";
  const [y, m, dd] = key.split(".");
  const d = new Date(Number(y), Number(m)-1, Number(dd));
  return `${m}월 ${dd}일 (${"일월화수목금토"[d.getDay()]})`;
};

const recalcTotals = (dishes) => ({
  total_calories: dishes.reduce((s, d) => s + Number(d.calories || 0), 0),
  total_protein:  dishes.reduce((s, d) => s + Number(d.protein  || 0), 0),
  total_carbs:    dishes.reduce((s, d) => s + Number(d.carbs    || 0), 0),
  total_fat:      dishes.reduce((s, d) => s + Number(d.fat      || 0), 0),
});

// MET values per exercise (kcal/kg/hr approximation via MET)
const EXERCISE_PRESETS = [
  { name: "런닝 (6km/h)",   met: 6.0,  unit: "reps", icon: "🏃" },
  { name: "런닝 (8km/h)",   met: 8.3,  unit: "reps", icon: "🏃" },
  { name: "런닝 (10km/h)",  met: 10.5, unit: "reps", icon: "🏃" },
  { name: "사이클",          met: 7.5,  unit: "rpm",  icon: "🚴" },
  { name: "수영",            met: 8.0,  unit: "reps", icon: "🏊" },
  { name: "스쿼트",          met: 5.0,  unit: "reps", icon: "🏋️" },
  { name: "데드리프트",      met: 6.0,  unit: "reps", icon: "🏋️" },
  { name: "벤치프레스",      met: 5.0,  unit: "reps", icon: "🏋️" },
  { name: "풀업",            met: 8.0,  unit: "reps", icon: "🏋️" },
  { name: "플랭크",          met: 4.0,  unit: "reps", icon: "🧘" },
  { name: "버피",            met: 8.0,  unit: "reps", icon: "💪" },
  { name: "줄넘기",          met: 10.0, unit: "rpm",  icon: "🪢" },
  { name: "요가",            met: 3.0,  unit: "reps", icon: "🧘" },
  { name: "걷기",            met: 3.5,  unit: "reps", icon: "🚶" },
  { name: "직접 입력",       met: 5.0,  unit: "reps", icon: "✏️" },
];

// Estimate burned kcal: MET * weight(kg) * time(hr)
// We approximate time from sets * reps * avgSecPerRep or sets * duration
const estimateBurnedKcal = (met, sets, reps, rpm, durationMin, weight = 70) => {
  let timeHr;
  if (durationMin > 0) {
    timeHr = durationMin / 60;
  } else if (rpm > 0) {
    // rpm-based: assume each set is 1 minute of work
    timeHr = (sets * 1) / 60;
  } else {
    // strength: ~3 seconds per rep, rest between sets
    const workSec = sets * reps * 3;
    const restSec = (sets - 1) * 60;
    timeHr = (workSec + restSec) / 3600;
  }
  return Math.round(met * weight * timeHr);
};

// ─── Shared helpers ───────────────────────────────────────────────────────────
const Macro = ({ label, val, color, unit = "g" }) => (
  <div style={{ textAlign: "center" }}>
    <div style={{ fontSize: 18, fontWeight: 700, color }}>{val}<span style={{ fontSize: 11, fontWeight: 400, color: C.muted }}>{unit}</span></div>
    <div style={{ fontSize: 10, color: C.muted, marginTop: 1 }}>{label}</div>
  </div>
);

const CalBar = ({ val, goal = DAILY_GOAL, burned = 0 }) => {
  const net = val - burned;
  const pct = Math.min((net / goal) * 100, 100);
  const over = net > goal;
  const barColor = over ? C.danger : pct > 80 ? C.orange : C.accent;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.muted, marginBottom: 4 }}>
        <span>순 섭취 {net.toLocaleString()} kcal</span>
        <span>목표 {goal.toLocaleString()} kcal</span>
      </div>
      <div style={{ height: 6, background: C.border, borderRadius: 99, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${Math.max(pct, 0)}%`, background: barColor, borderRadius: 99, transition: "width 0.4s" }} />
      </div>
      {over && <div style={{ fontSize: 10, color: C.danger, marginTop: 4 }}>목표 초과 +{(net - goal).toLocaleString()} kcal</div>}
    </div>
  );
};

// ─── Food editing helpers ─────────────────────────────────────────────────────
const numInput = (val, onChange, color) => (
  <input type="number" value={val} onChange={e => onChange(Number(e.target.value))}
    style={{ width: 54, background: "#2a2a2a", border: `1px solid ${C.border}`, borderRadius: 4, color, fontFamily: "inherit", fontSize: 12, fontWeight: 700, padding: "3px 6px", textAlign: "right", outline: "none" }}
    onFocus={e => e.target.style.borderColor = C.accent}
    onBlur={e => e.target.style.borderColor = C.border} />
);

const DishRow = ({ dish, editing, onEdit, onSave, onCancel, onDelete }) => {
  const [local, setLocal] = useState({ ...dish });
  useEffect(() => { setLocal({ ...dish }); }, [dish]);
  return (
    <div style={{ background: editing ? "#1e2600" : C.card, border: `1px solid ${editing ? C.accentDim : C.border}`, borderRadius: 8, marginBottom: 8, overflow: "hidden", transition: "all 0.15s" }}>
      <div style={{ display: "flex", alignItems: "center", padding: "12px 14px", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {editing
            ? <input value={local.name} onChange={e => setLocal(p => ({ ...p, name: e.target.value }))}
                style={{ width: "100%", background: "#2a2a2a", border: `1px solid ${C.border}`, borderRadius: 4, color: C.text, fontFamily: "inherit", fontSize: 13, fontWeight: 600, padding: "4px 8px", outline: "none" }}
                onFocus={e => e.target.style.borderColor = C.accent} onBlur={e => e.target.style.borderColor = C.border} />
            : <div style={{ fontWeight: 600, fontSize: 14, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{dish.name}</div>
          }
          {!editing && <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{dish.portion}</div>}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          {editing ? numInput(local.calories, v => setLocal(p => ({ ...p, calories: v })), C.accent)
            : <span style={{ fontSize: 13, fontWeight: 700, color: C.accent }}>{dish.calories}</span>}
          <div style={{ fontSize: 10, color: C.muted }}>kcal</div>
        </div>
        {!editing && <button onClick={onEdit} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.muted, borderRadius: 4, cursor: "pointer", padding: "4px 8px", fontSize: 11, fontFamily: "inherit", flexShrink: 0 }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = C.accent; e.currentTarget.style.color = C.accent; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.muted; }}>✏️</button>}
        {!editing && onDelete && <button onClick={onDelete} style={{ background: "transparent", border: "none", color: C.border, fontSize: 16, cursor: "pointer", padding: "0 4px", flexShrink: 0 }}
          onMouseEnter={e => e.currentTarget.style.color = C.danger} onMouseLeave={e => e.currentTarget.style.color = C.border}>×</button>}
      </div>
      {editing && (
        <div style={{ padding: "0 14px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ fontSize: 11, color: C.blue, display: "flex", alignItems: "center", gap: 6 }}>단백질 {numInput(local.protein, v => setLocal(p => ({ ...p, protein: v })), C.blue)} g</label>
            <label style={{ fontSize: 11, color: C.orange, display: "flex", alignItems: "center", gap: 6 }}>탄수화물 {numInput(local.carbs, v => setLocal(p => ({ ...p, carbs: v })), C.orange)} g</label>
            <label style={{ fontSize: 11, color: C.red, display: "flex", alignItems: "center", gap: 6 }}>지방 {numInput(local.fat, v => setLocal(p => ({ ...p, fat: v })), C.red)} g</label>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => onSave(local)} style={{ flex: 1, background: C.accent, color: "#000", border: "none", borderRadius: 5, padding: "8px", fontFamily: "inherit", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>저장</button>
            <button onClick={onCancel} style={{ flex: 1, background: "transparent", border: `1px solid ${C.border}`, color: C.muted, borderRadius: 5, padding: "8px", fontFamily: "inherit", fontSize: 12, cursor: "pointer" }}>취소</button>
          </div>
        </div>
      )}
    </div>
  );
};

const EditableMealResult = ({ res: initRes, img, onUpdate }) => {
  const [res, setRes] = useState(initRes);
  const [editingIdx, setEditingIdx] = useState(null);
  const handleSave = (idx, updated) => {
    const newDishes = res.dishes.map((d, i) => i === idx ? updated : d);
    const newRes = { ...res, dishes: newDishes, ...recalcTotals(newDishes) };
    setRes(newRes); setEditingIdx(null); onUpdate?.(newRes);
  };
  const handleDeleteDish = (idx) => {
    const newDishes = res.dishes.filter((_, i) => i !== idx);
    const newRes = { ...res, dishes: newDishes, ...recalcTotals(newDishes) };
    setRes(newRes); onUpdate?.(newRes);
  };
  return (
    <div>
      <div style={{ position: "relative", borderRadius: 8, overflow: "hidden", marginBottom: 20 }}>
        <img src={img} alt="food" style={{ width: "100%", maxHeight: 300, objectFit: "cover", display: "block" }} />
      </div>
      <div style={{ display: "flex", gap: 12, marginBottom: 20, alignItems: "center" }}>
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 16px", fontSize: 13, color: C.muted }}>🍽 {res.meal_type}</div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: C.muted }}>건강점수</span>
          <span style={{ background: res.health_score >= 7 ? C.accent : res.health_score >= 4 ? C.orange : C.red, color: "#000", fontWeight: 700, fontSize: 15, borderRadius: 4, padding: "2px 10px" }}>{res.health_score}/10</span>
        </div>
      </div>
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "24px 28px", marginBottom: 16, textAlign: "center" }}>
        <div style={{ fontSize: 11, color: C.muted, letterSpacing: 2, marginBottom: 8 }}>TOTAL CALORIES</div>
        <div style={{ fontSize: 60, fontWeight: 700, color: C.accent, lineHeight: 1 }}>{res.total_calories}</div>
        <div style={{ fontSize: 14, color: C.muted, marginTop: 4 }}>kcal</div>
        <div style={{ display: "flex", justifyContent: "center", gap: 28, marginTop: 20, paddingTop: 16, borderTop: `1px solid ${C.border}` }}>
          <Macro label="단백질" val={res.total_protein} color={C.blue} />
          <Macro label="탄수화물" val={res.total_carbs} color={C.orange} />
          <Macro label="지방" val={res.total_fat} color={C.red} />
        </div>
      </div>
      {res.dishes?.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: C.muted, letterSpacing: 2, marginBottom: 10 }}>음식 항목 <span style={{ color: C.accentDim, fontSize: 10 }}>✏️ 클릭하여 수정</span></div>
          {res.dishes.map((dish, i) => (
            <DishRow key={i} dish={dish} editing={editingIdx === i}
              onEdit={() => setEditingIdx(editingIdx === i ? null : i)}
              onSave={(u) => handleSave(i, u)} onCancel={() => setEditingIdx(null)}
              onDelete={() => handleDeleteDish(i)} />
          ))}
        </div>
      )}
      {res.tip && <div style={{ background: "#1a2200", border: `1px solid ${C.accentDim}`, borderRadius: 6, padding: "12px 16px", fontSize: 13, color: C.accent, lineHeight: 1.6 }}>💡 {res.tip}</div>}
    </div>
  );
};


// ─── Workout Tab ──────────────────────────────────────────────────────────────
const WorkoutTab = ({ workoutHistory, setWorkoutHistory, saveWorkoutHistory }) => {
  const WEIGHT = 70;
  const [subView, setSubView] = useState("list");
  const [addTab, setAddTab] = useState("manual");
  const [selectedDay, setSelectedDay] = useState(null);

  // Manual form
  const [preset, setPreset] = useState(EXERCISE_PRESETS[5]);
  const [customName, setCustomName] = useState("");
  const [customMet, setCustomMet] = useState(5);
  const [sets, setSets] = useState(3);
  const [reps, setReps] = useState(10);
  const [rpm, setRpm] = useState(0);
  const [durationMin, setDurationMin] = useState(0);
  const [weight, setWeight] = useState(WEIGHT);

  // Paste form
  const [memoText, setMemoText] = useState("");
  const [pasteLoading, setPasteLoading] = useState(false);
  const [parsedWorkouts, setParsedWorkouts] = useState(null);
  const [pasteWeight, setPasteWeight] = useState(WEIGHT);
  const [pasteError, setPasteError] = useState(null);

  const isCustom = preset.name === "직접 입력";
  const isRpmBased = preset.unit === "rpm" && !isCustom;
  const met = isCustom ? customMet : preset.met;
  const previewKcal = estimateBurnedKcal(met, sets, isRpmBased ? rpm : reps, rpm, durationMin, weight);

  const handleAdd = async () => {
    const name = isCustom ? (customName || "커스텀 운동") : preset.name;
    const record = {
      id: Date.now(), time: new Date().toISOString(), name,
      icon: isCustom ? "💪" : preset.icon, sets,
      reps: isRpmBased ? rpm : reps, repUnit: isRpmBased ? "rpm" : "회",
      durationMin, burnedKcal: previewKcal, met, weight,
    };
    const newHistory = [record, ...workoutHistory].slice(0, MAX_RECORDS);
    setWorkoutHistory(newHistory); await saveWorkoutHistory(newHistory);
    setSubView("list");
  };

  const handleParseMemo = async () => {
    if (!memoText.trim()) return;
    setPasteLoading(true); setPasteError(null); setParsedWorkouts(null);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 1000,
          messages: [{ role: "user", content: `다음은 사용자가 메모장에 적어둔 운동 기록입니다. 이걸 분석해서 반드시 JSON 배열 형식으로만 응답하세요. 다른 텍스트나 마크다운은 절대 포함하지 마세요.

메모:
${memoText}

각 운동에 대해 아래 형식으로 추출하세요:
[{"name":"운동이름(한국어)","icon":"관련이모지","sets":세트수숫자없으면1,"reps":반복횟수숫자없으면0,"repUnit":"회또는rpm","durationMin":운동시간분숫자없으면0,"met":MET값숫자근력운동5~8유산소8~12스트레칭3~4,"note":"원문핵심메모있으면없으면빈문자열"}]

운동이 여러 개면 배열로 모두 포함. 알 수 없으면 빈 배열 [].` }]
        })
      });
      const data = await res.json();
      const text = data.content.map(b => b.text||"").join("").replace(/```json|```/g,"").trim();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("운동 내용을 인식하지 못했습니다.");
      const withKcal = parsed.map(w => ({
        ...w,
        burnedKcal: estimateBurnedKcal(w.met, w.sets, w.reps, w.repUnit === "rpm" ? w.reps : 0, w.durationMin, pasteWeight),
      }));
      setParsedWorkouts(withKcal);
    } catch(e) {
      setPasteError(e.message || "파싱 중 오류가 발생했습니다.");
    } finally { setPasteLoading(false); }
  };

  const handleSaveParsed = async () => {
    const now = Date.now();
    const records = parsedWorkouts.map((w, i) => ({
      id: now + i, time: new Date().toISOString(),
      name: w.name, icon: w.icon || "💪",
      sets: w.sets, reps: w.reps, repUnit: w.repUnit,
      durationMin: w.durationMin, burnedKcal: w.burnedKcal,
      met: w.met, weight: pasteWeight,
    }));
    const newHistory = [...records, ...workoutHistory].slice(0, MAX_RECORDS);
    setWorkoutHistory(newHistory); await saveWorkoutHistory(newHistory);
    setMemoText(""); setParsedWorkouts(null); setSubView("list");
  };

  const deleteWorkout = async (id) => {
    const nh = workoutHistory.filter(w => w.id !== id);
    setWorkoutHistory(nh); await saveWorkoutHistory(nh);
    const remaining = nh.filter(w => toDateKey(w.time) === selectedDay);
    if (remaining.length === 0) setSelectedDay(null);
  };

  const grouped = workoutHistory.reduce((acc, r) => {
    const k = toDateKey(r.time); if (!acc[k]) acc[k] = []; acc[k].push(r); return acc;
  }, {});
  const sortedDates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));
  const todayBurned = (grouped[todayKey] || []).reduce((s, w) => s + w.burnedKcal, 0);

  // ── Add view ──
  if (subView === "add") return (
    <div>
      <button onClick={() => { setSubView("list"); setParsedWorkouts(null); setMemoText(""); setPasteError(null); }}
        style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.muted, fontFamily: "inherit", fontSize: 12, padding: "6px 14px", borderRadius: 4, cursor: "pointer", marginBottom: 20, letterSpacing: 1 }}>
        ← 목록으로
      </button>

      {/* Sub-tabs */}
      <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, marginBottom: 24 }}>
        {[{ k: "manual", l: "✍️ 직접 입력" }, { k: "paste", l: "📋 메모 붙여넣기" }].map(t => (
          <button key={t.k} onClick={() => { setAddTab(t.k); setParsedWorkouts(null); setPasteError(null); }}
            style={{ background: "transparent", border: "none", borderBottom: addTab === t.k ? `2px solid ${C.accent}` : "2px solid transparent", color: addTab === t.k ? C.accent : C.muted, fontFamily: "inherit", fontSize: 13, fontWeight: 600, padding: "10px 18px 8px", cursor: "pointer", marginBottom: -1 }}>
            {t.l}
          </button>
        ))}
      </div>

      {/* ── MANUAL ── */}
      {addTab === "manual" && (
        <div>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: C.muted, letterSpacing: 1, marginBottom: 8 }}>운동 선택</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {EXERCISE_PRESETS.map(p => (
                <button key={p.name} onClick={() => setPreset(p)}
                  style={{ background: preset.name === p.name ? C.accent : C.card, color: preset.name === p.name ? "#000" : C.muted, border: `1px solid ${preset.name === p.name ? C.accent : C.border}`, borderRadius: 20, padding: "6px 14px", fontFamily: "inherit", fontSize: 12, cursor: "pointer", fontWeight: preset.name === p.name ? 700 : 400 }}>
                  {p.icon} {p.name}
                </button>
              ))}
            </div>
          </div>
          {isCustom && (
            <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
              <div style={{ flex: 2 }}>
                <div style={{ fontSize: 11, color: C.muted, letterSpacing: 1, marginBottom: 6 }}>운동 이름</div>
                <input value={customName} onChange={e => setCustomName(e.target.value)} placeholder="예: 케틀벨 스윙"
                  style={{ width: "100%", background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, fontFamily: "inherit", fontSize: 14, padding: "10px 12px", outline: "none", boxSizing: "border-box" }}
                  onFocus={e => e.target.style.borderColor = C.accent} onBlur={e => e.target.style.borderColor = C.border} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: C.muted, letterSpacing: 1, marginBottom: 6 }}>강도 (MET)</div>
                <input type="number" value={customMet} onChange={e => setCustomMet(Number(e.target.value))} min={1} max={20}
                  style={{ width: "100%", background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, fontFamily: "inherit", fontSize: 14, padding: "10px 12px", outline: "none", boxSizing: "border-box" }}
                  onFocus={e => e.target.style.borderColor = C.accent} onBlur={e => e.target.style.borderColor = C.border} />
              </div>
            </div>
          )}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: C.muted, letterSpacing: 1, marginBottom: 6 }}>체중 (kg) — 칼로리 계산 기준</div>
            <input type="number" value={weight} onChange={e => setWeight(Number(e.target.value))}
              style={{ width: 100, background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, fontFamily: "inherit", fontSize: 14, padding: "10px 12px", outline: "none" }}
              onFocus={e => e.target.style.borderColor = C.accent} onBlur={e => e.target.style.borderColor = C.border} />
          </div>
          <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 11, color: C.muted, letterSpacing: 1, marginBottom: 6 }}>세트 수</div>
              <input type="number" value={sets} onChange={e => setSets(Number(e.target.value))} min={1}
                style={{ width: 80, background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, color: C.accent, fontFamily: "inherit", fontSize: 18, fontWeight: 700, padding: "10px 12px", outline: "none", textAlign: "center" }}
                onFocus={e => e.target.style.borderColor = C.accent} onBlur={e => e.target.style.borderColor = C.border} />
              <div style={{ fontSize: 10, color: C.muted, textAlign: "center", marginTop: 4 }}>세트</div>
            </div>
            {isRpmBased ? (
              <div>
                <div style={{ fontSize: 11, color: C.muted, letterSpacing: 1, marginBottom: 6 }}>RPM</div>
                <input type="number" value={rpm} onChange={e => setRpm(Number(e.target.value))} min={0}
                  style={{ width: 80, background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, color: C.purple, fontFamily: "inherit", fontSize: 18, fontWeight: 700, padding: "10px 12px", outline: "none", textAlign: "center" }}
                  onFocus={e => e.target.style.borderColor = C.accent} onBlur={e => e.target.style.borderColor = C.border} />
                <div style={{ fontSize: 10, color: C.muted, textAlign: "center", marginTop: 4 }}>rpm</div>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 11, color: C.muted, letterSpacing: 1, marginBottom: 6 }}>반복 횟수</div>
                <input type="number" value={reps} onChange={e => setReps(Number(e.target.value))} min={1}
                  style={{ width: 80, background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, color: C.blue, fontFamily: "inherit", fontSize: 18, fontWeight: 700, padding: "10px 12px", outline: "none", textAlign: "center" }}
                  onFocus={e => e.target.style.borderColor = C.accent} onBlur={e => e.target.style.borderColor = C.border} />
                <div style={{ fontSize: 10, color: C.muted, textAlign: "center", marginTop: 4 }}>회</div>
              </div>
            )}
            <div>
              <div style={{ fontSize: 11, color: C.muted, letterSpacing: 1, marginBottom: 6 }}>운동 시간</div>
              <input type="number" value={durationMin} onChange={e => setDurationMin(Number(e.target.value))} min={0}
                style={{ width: 80, background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, color: C.orange, fontFamily: "inherit", fontSize: 18, fontWeight: 700, padding: "10px 12px", outline: "none", textAlign: "center" }}
                onFocus={e => e.target.style.borderColor = C.accent} onBlur={e => e.target.style.borderColor = C.border} />
              <div style={{ fontSize: 10, color: C.muted, textAlign: "center", marginTop: 4 }}>분 (0=자동)</div>
            </div>
          </div>
          <div style={{ background: "#0d1a00", border: `1px solid ${C.accentDim}`, borderRadius: 10, padding: "20px 24px", marginBottom: 20, textAlign: "center" }}>
            <div style={{ fontSize: 11, color: C.muted, letterSpacing: 2, marginBottom: 6 }}>예상 소모 칼로리</div>
            <div style={{ fontSize: 52, fontWeight: 700, color: C.accent, lineHeight: 1 }}>{previewKcal}</div>
            <div style={{ fontSize: 13, color: C.muted, marginTop: 4 }}>kcal</div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
              {preset.icon} {isCustom ? (customName || "커스텀 운동") : preset.name} · {sets}세트
              {isRpmBased ? ` · ${rpm}rpm` : ` · ${reps}회`}
              {durationMin > 0 ? ` · ${durationMin}분` : ""} · {weight}kg
            </div>
          </div>
          <button onClick={handleAdd}
            style={{ width: "100%", padding: "16px", background: C.accent, color: "#000", border: "none", borderRadius: 6, fontFamily: "inherit", fontSize: 15, fontWeight: 700, letterSpacing: 1, cursor: "pointer" }}>
            💪 운동 기록 저장
          </button>
        </div>
      )}

      {/* ── PASTE ── */}
      {addTab === "paste" && (
        <div>
          <div style={{ background: "#1a1500", border: `1px solid #3a3000`, borderRadius: 8, padding: "12px 16px", marginBottom: 16, fontSize: 12, color: C.orange, lineHeight: 1.6 }}>
            💡 메모장에 적어둔 운동 기록을 그대로 붙여넣으면 AI가 자동으로 분석해드려요.<br/>
            <span style={{ color: C.muted, fontSize: 11 }}>형식 상관없이 자유롭게 — "스쿼트 5세트 10회", "bench 4x8", "런닝 30분" 모두 OK</span>
          </div>

          <textarea
            value={memoText}
            onChange={e => { setMemoText(e.target.value); setParsedWorkouts(null); setPasteError(null); }}
            placeholder={"여기에 운동 메모를 붙여넣으세요 ↓\n\n예시:\n스쿼트 5set 10rep\n벤치프레스 4x8 60kg\n런닝머신 30분\n풀업 3세트 12회\n플랭크 1분 x 3"}
            rows={9}
            style={{ width: "100%", background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontFamily: "inherit", fontSize: 13, padding: "14px", outline: "none", resize: "vertical", lineHeight: 1.8, boxSizing: "border-box" }}
            onFocus={e => e.target.style.borderColor = C.accent}
            onBlur={e => e.target.style.borderColor = C.border}
          />

          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, marginBottom: 20 }}>
            <span style={{ fontSize: 11, color: C.muted }}>내 체중</span>
            <input type="number" value={pasteWeight} onChange={e => setPasteWeight(Number(e.target.value))}
              style={{ width: 70, background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, fontFamily: "inherit", fontSize: 14, padding: "6px 10px", outline: "none", textAlign: "center" }}
              onFocus={e => e.target.style.borderColor = C.accent} onBlur={e => e.target.style.borderColor = C.border} />
            <span style={{ fontSize: 11, color: C.muted }}>kg (소모 칼로리 계산 기준)</span>
          </div>

          {!parsedWorkouts && (
            <button onClick={handleParseMemo} disabled={pasteLoading || !memoText.trim()}
              style={{ width: "100%", padding: "14px", background: pasteLoading || !memoText.trim() ? C.border : C.accent, color: pasteLoading || !memoText.trim() ? C.muted : "#000", border: "none", borderRadius: 6, fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: pasteLoading || !memoText.trim() ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
              {pasteLoading
                ? <><span style={{ display: "inline-block", width: 16, height: 16, border: `2px solid ${C.muted}`, borderTopColor: C.accent, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />AI가 분석 중...</>
                : "🤖 AI로 자동 분석하기"}
            </button>
          )}

          {pasteError && (
            <div style={{ background: "#2a1010", border: `1px solid ${C.danger}`, borderRadius: 6, padding: 14, marginTop: 12, color: C.danger, fontSize: 13 }}>⚠️ {pasteError}</div>
          )}

          {parsedWorkouts && (
            <div style={{ marginTop: 4 }}>
              <div style={{ fontSize: 11, color: C.accentDim, letterSpacing: 1, marginBottom: 14 }}>
                ✅ {parsedWorkouts.length}개 운동 인식 완료 — 확인 후 저장하세요
              </div>

              {parsedWorkouts.map((w, i) => (
                <div key={i} style={{ background: "#0d1a00", border: `1px solid ${C.accentDim}`, borderRadius: 8, padding: "12px 16px", marginBottom: 8, display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ fontSize: 26, flexShrink: 0 }}>{w.icon || "💪"}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: C.text }}>{w.name}</div>
                    <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>
                      {w.sets}세트 · {w.reps}{w.repUnit}
                      {w.durationMin > 0 ? ` · ${w.durationMin}분` : ""}
                    </div>
                    {w.note && <div style={{ fontSize: 11, color: C.accentDim, marginTop: 3 }}>📝 {w.note}</div>}
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontSize: 20, fontWeight: 700, color: C.purple }}>{w.burnedKcal}</div>
                    <div style={{ fontSize: 10, color: C.muted }}>kcal</div>
                  </div>
                </div>
              ))}

              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "14px 16px", marginTop: 4, marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 13, color: C.muted }}>총 소모 예상</span>
                <span style={{ fontSize: 22, fontWeight: 700, color: C.purple }}>{parsedWorkouts.reduce((s, w) => s + w.burnedKcal, 0).toLocaleString()} kcal</span>
              </div>

              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={handleSaveParsed}
                  style={{ flex: 2, padding: "14px", background: C.accent, color: "#000", border: "none", borderRadius: 6, fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
                  💾 전체 저장
                </button>
                <button onClick={() => { setParsedWorkouts(null); setPasteError(null); }}
                  style={{ flex: 1, padding: "14px", background: "transparent", border: `1px solid ${C.border}`, color: C.muted, borderRadius: 6, fontFamily: "inherit", fontSize: 13, cursor: "pointer" }}>
                  다시 분석
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );

  // ── Day detail ──
  if (subView === "dayDetail" && selectedDay) {
    const records = grouped[selectedDay] || [];
    const dayBurned = records.reduce((s, w) => s + w.burnedKcal, 0);
    return (
      <div>
        <button onClick={() => setSubView("list")} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.muted, fontFamily: "inherit", fontSize: 12, padding: "6px 14px", borderRadius: 4, cursor: "pointer", marginBottom: 20, letterSpacing: 1 }}>← 목록으로</button>
        <div style={{ fontSize: 20, fontWeight: 700, color: selectedDay === todayKey ? C.accent : C.text, marginBottom: 4 }}>{formatDateLabel(selectedDay)}</div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 20 }}>{records.length}개 운동</div>
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "24px", marginBottom: 16, textAlign: "center" }}>
          <div style={{ fontSize: 11, color: C.muted, letterSpacing: 2, marginBottom: 6 }}>하루 총 소모</div>
          <div style={{ fontSize: 52, fontWeight: 700, color: C.purple, lineHeight: 1 }}>{dayBurned.toLocaleString()}</div>
          <div style={{ fontSize: 13, color: C.muted, marginTop: 4 }}>kcal 소모</div>
          <div style={{ display: "flex", justifyContent: "center", gap: 28, marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: C.orange }}>{records.length}</div>
              <div style={{ fontSize: 10, color: C.muted }}>운동 종목</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: C.blue }}>{records.reduce((s, w) => s + w.sets, 0)}</div>
              <div style={{ fontSize: 10, color: C.muted }}>총 세트</div>
            </div>
          </div>
        </div>
        <div style={{ fontSize: 11, color: C.muted, letterSpacing: 2, marginBottom: 12 }}>운동 목록</div>
        {records.map(w => (
          <div key={w.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "14px 16px", marginBottom: 8, display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ fontSize: 28, flexShrink: 0 }}>{w.icon}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: C.text }}>{w.name}</div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>
                {w.sets}세트 · {w.reps}{w.repUnit}
                {w.durationMin > 0 ? ` · ${w.durationMin}분` : ""}
                · {w.weight}kg
              </div>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: C.purple }}>{w.burnedKcal}</div>
              <div style={{ fontSize: 10, color: C.muted }}>kcal</div>
            </div>
            <button onClick={() => deleteWorkout(w.id)}
              style={{ background: "transparent", border: "none", color: C.border, fontSize: 18, cursor: "pointer", padding: "0 4px" }}
              onMouseEnter={e => e.currentTarget.style.color = C.danger}
              onMouseLeave={e => e.currentTarget.style.color = C.border}>×</button>
          </div>
        ))}
      </div>
    );
  }

  // ── List view ──
  return (
    <div>
      {todayBurned > 0 && (
        <div style={{ background: "#160d1f", border: `1px solid #2a1a40`, borderRadius: 8, padding: "14px 18px", marginBottom: 20, display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ fontSize: 28 }}>🔥</div>
          <div>
            <div style={{ fontSize: 11, color: C.muted }}>오늘 소모 칼로리</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: C.purple }}>{todayBurned.toLocaleString()} kcal</div>
          </div>
          <div style={{ marginLeft: "auto", textAlign: "right" }}>
            <div style={{ fontSize: 11, color: C.muted }}>{(grouped[todayKey] || []).length}종목</div>
            <div style={{ fontSize: 11, color: C.muted }}>{(grouped[todayKey] || []).reduce((s, w) => s + w.sets, 0)}세트</div>
          </div>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: C.muted, letterSpacing: 2 }}>날짜별 운동 기록</div>
        <button onClick={() => setSubView("add")}
          style={{ background: C.accent, color: "#000", border: "none", borderRadius: 6, padding: "8px 18px", fontFamily: "inherit", fontSize: 13, fontWeight: 700, cursor: "pointer", letterSpacing: 0.5 }}>
          + 운동 추가
        </button>
      </div>
      {sortedDates.length === 0 ? (
        <div style={{ textAlign: "center", padding: "80px 0", color: C.muted }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>💪</div>
          <div style={{ fontSize: 15 }}>아직 운동 기록이 없습니다</div>
          <div style={{ fontSize: 12, marginTop: 8 }}>운동을 기록해보세요!</div>
          <button onClick={() => setSubView("add")}
            style={{ marginTop: 20, background: C.accent, color: "#000", border: "none", borderRadius: 6, padding: "10px 24px", fontFamily: "inherit", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
            + 운동 추가
          </button>
        </div>
      ) : (
        sortedDates.map(dateKey => {
          const records = grouped[dateKey];
          const dayBurned = records.reduce((s, w) => s + w.burnedKcal, 0);
          const isToday = dateKey === todayKey;
          return (
            <div key={dateKey} onClick={() => { setSelectedDay(dateKey); setSubView("dayDetail"); }}
              style={{ background: C.card, border: `1px solid ${isToday ? "#3a1a5a" : C.border}`, borderRadius: 10, padding: "16px 18px", marginBottom: 10, cursor: "pointer", transition: "border-color 0.15s" }}
              onMouseEnter={e => e.currentTarget.style.borderColor = C.purple}
              onMouseLeave={e => e.currentTarget.style.borderColor = isToday ? "#3a1a5a" : C.border}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {isToday && <span style={{ background: C.purple, color: "#000", fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 3, letterSpacing: 1 }}>TODAY</span>}
                  <span style={{ fontSize: 14, fontWeight: 700, color: isToday ? C.purple : C.text }}>{formatDateLabel(dateKey)}</span>
                  <span style={{ fontSize: 11, color: C.muted }}>{records.length}종목</span>
                </div>
                <span style={{ fontSize: 10, color: C.muted }}>→</span>
              </div>
              <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
                <div>
                  <span style={{ fontSize: 32, fontWeight: 700, color: C.purple, lineHeight: 1 }}>{dayBurned.toLocaleString()}</span>
                  <span style={{ fontSize: 13, color: C.muted, marginLeft: 4 }}>kcal 소모</span>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {records.slice(0, 5).map(w => (
                    <div key={w.id} style={{ width: 32, height: 32, borderRadius: 6, background: "#2a1a3a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>{w.icon}</div>
                  ))}
                </div>
              </div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>
                {records.map(w => w.name).join(" · ")}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
};


// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [image, setImage]         = useState(null);
  const [imageBase64, setImageBase64] = useState(null);
  const [loading, setLoading]     = useState(false);
  const [result, setResult]       = useState(null);
  const [currentRecordId, setCurrentRecordId] = useState(null);
  const [error, setError]         = useState(null);
  const [dragOver, setDragOver]   = useState(false);
  const [foodHistory, setFoodHistory]       = useState([]);
  const [workoutHistory, setWorkoutHistory] = useState([]);
  const [view, setView]           = useState("upload");
  const [selectedDay, setSelectedDay] = useState(null);
  const [apiKey, setApiKey]       = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [showKeySetup, setShowKeySetup] = useState(false);
  const fileRef = useRef();

  useEffect(() => {
    (async () => {
      try {
        const f = await window.storage.get(FOOD_KEY);
        if (f?.value) setFoodHistory(JSON.parse(f.value));
      } catch (_) {}
      try {
        const w = await window.storage.get(WORKOUT_KEY);
        if (w?.value) setWorkoutHistory(JSON.parse(w.value));
      } catch (_) {}
      const savedKey = localStorage.getItem("anthropic-api-key");
      if (savedKey) setApiKey(savedKey);
    })();
  }, []);

  const saveApiKey = () => {
    const k = apiKeyInput.trim();
    if (!k.startsWith("sk-ant-")) { alert("올바른 API 키를 입력해주세요 (sk-ant-로 시작)"); return; }
    localStorage.setItem("anthropic-api-key", k);
    setApiKey(k); setShowKeySetup(false); setApiKeyInput("");
  };

  const saveFoodHistory = async (h) => {
    try { await window.storage.set(FOOD_KEY, JSON.stringify(h)); } catch (_) {}
  };
  const saveWorkoutHistory = async (h) => {
    try { await window.storage.set(WORKOUT_KEY, JSON.stringify(h)); } catch (_) {}
  };

  const processFile = useCallback((file) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      setImage(e.target.result); setImageBase64(e.target.result.split(",")[1]);
      setResult(null); setError(null); setView("upload");
    };
    reader.readAsDataURL(file);
  }, []);

  const analyze = async () => {
    if (!imageBase64) return;
    setLoading(true); setError(null);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 1000,
          messages: [{ role: "user", content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } },
            { type: "text", text: `이 음식 사진을 분석해서 반드시 아래 JSON 형식으로만 응답하세요. 다른 텍스트는 절대 포함하지 마세요.
{"dishes":[{"name":"음식이름(한국어)","portion":"예상 양","calories":숫자,"protein":숫자,"carbs":숫자,"fat":숫자}],"total_calories":숫자,"total_protein":숫자,"total_carbs":숫자,"total_fat":숫자,"meal_type":"아침/점심/저녁/간식 중 하나","health_score":1~10숫자,"tip":"영양 팁 한 문장"}
음식이 없거나 식별 불가능하면: {"error": "음식을 인식할 수 없습니다"}` }
          ]}]
        })
      });
      const data = await res.json();
      const parsed = JSON.parse(data.content.map(b => b.text||"").join("").replace(/```json|```/g,"").trim());
      if (parsed.error) throw new Error(parsed.error);
      const id = Date.now();
      const newRecord = { id, image, result: parsed, time: new Date().toISOString() };
      setResult(parsed); setCurrentRecordId(id); setView("result");
      const newHistory = [newRecord, ...foodHistory].slice(0, MAX_RECORDS);
      setFoodHistory(newHistory); await saveFoodHistory(newHistory);
    } catch (e) { setError(e.message || "분석 중 오류가 발생했습니다."); }
    finally { setLoading(false); }
  };

  const handleResultUpdate = async (newResult) => {
    setResult(newResult);
    const nh = foodHistory.map(h => h.id === currentRecordId ? { ...h, result: newResult } : h);
    setFoodHistory(nh); await saveFoodHistory(nh);
  };
  const handleRecordUpdate = async (id, newResult) => {
    const nh = foodHistory.map(h => h.id === id ? { ...h, result: newResult } : h);
    setFoodHistory(nh); await saveFoodHistory(nh);
  };
  const deleteRecord = async (id) => {
    const nh = foodHistory.filter(h => h.id !== id);
    setFoodHistory(nh); await saveFoodHistory(nh);
    const remaining = nh.filter(h => toDateKey(h.time) === selectedDay);
    if (remaining.length === 0) setSelectedDay(null);
  };
  const reset = () => { setImage(null); setImageBase64(null); setResult(null); setCurrentRecordId(null); setError(null); setView("upload"); };

  const groupedFood = foodHistory.reduce((acc, r) => {
    const k = toDateKey(r.time); if (!acc[k]) acc[k] = []; acc[k].push(r); return acc;
  }, {});
  const sortedFoodDates = Object.keys(groupedFood).sort((a, b) => b.localeCompare(a));
  const todayFoodRecords = groupedFood[todayKey] || [];
  const todayFoodTotal   = todayFoodRecords.reduce((s, r) => s + r.result.total_calories, 0);
  const todayFoodGoalPct = Math.min(Math.round((todayFoodTotal / DAILY_GOAL) * 100), 100);
  const todayBurned      = (workoutHistory.filter(w => toDateKey(w.time) === todayKey)).reduce((s, w) => s + w.burnedKcal, 0);

  const TABS = [
    { key: "upload", label: "📷 분석" },
    { key: "history", label: `🍽 식사${foodHistory.length > 0 ? ` (${foodHistory.length})` : ""}` },
    { key: "workout", label: `💪 운동${workoutHistory.length > 0 ? ` (${workoutHistory.length})` : ""}` },
  ];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'DM Mono','Courier New',monospace", padding: "0 0 60px" }}>

      {/* Header */}
      <div style={{ borderBottom: `1px solid ${C.border}`, padding: "16px 20px", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ background: C.accent, color: "#000", fontWeight: 700, fontSize: 11, padding: "3px 8px", letterSpacing: 2 }}>KCAL</div>
        <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: -0.5 }}>AI 칼로리 분석기</div>
        <button onClick={() => setShowKeySetup(s => !s)} title="API 키 설정"
          style={{ marginLeft: "auto", background: apiKey ? "#1a2600" : "#2a1010", border: `1px solid ${apiKey ? C.accentDim : C.danger}`, color: apiKey ? C.accent : C.danger, borderRadius: 6, padding: "5px 10px", fontFamily: "inherit", fontSize: 11, cursor: "pointer" }}>
          {apiKey ? "🔑 키 설정됨" : "🔑 키 필요"}
        </button>
      </div>

      {/* API Key Setup Panel */}
      {showKeySetup && (
        <div style={{ background: "#1a1000", borderBottom: `1px solid #3a2800`, padding: "16px 24px" }}>
          <div style={{ fontSize: 13, color: C.orange, marginBottom: 10, fontWeight: 600 }}>🔑 Anthropic API 키 입력</div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 12 }}>
            console.anthropic.com에서 발급받은 키를 입력하세요.<br/>키는 이 기기에만 저장되고 외부로 전송되지 않아요.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="password"
              value={apiKeyInput}
              onChange={e => setApiKeyInput(e.target.value)}
              placeholder="sk-ant-..."
              style={{ flex: 1, background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, fontFamily: "inherit", fontSize: 13, padding: "10px 12px", outline: "none" }}
              onFocus={e => e.target.style.borderColor = C.accent}
              onBlur={e => e.target.style.borderColor = C.border}
              onKeyDown={e => e.key === "Enter" && saveApiKey()}
            />
            <button onClick={saveApiKey}
              style={{ background: C.accent, color: "#000", border: "none", borderRadius: 6, padding: "10px 18px", fontFamily: "inherit", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
              저장
            </button>
          </div>
          {apiKey && (
            <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 11, color: C.accent }}>✅ 현재 키: {apiKey.slice(0,16)}...</span>
              <button onClick={() => { localStorage.removeItem("anthropic-api-key"); setApiKey(""); setShowKeySetup(false); }}
                style={{ background: "transparent", border: `1px solid #3a1010`, color: C.danger, fontFamily: "inherit", fontSize: 11, padding: "3px 10px", borderRadius: 4, cursor: "pointer" }}>
                키 삭제
              </button>
            </div>
          )}
        </div>
      )}

      {/* No key warning */}
      {!apiKey && !showKeySetup && (
        <div style={{ background: "#2a1010", borderBottom: `1px solid #4a2020`, padding: "10px 24px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 12, color: C.danger }}>⚠️ API 키를 먼저 입력해야 분석이 가능해요</span>
          <button onClick={() => setShowKeySetup(true)}
            style={{ background: C.danger, color: "#fff", border: "none", borderRadius: 4, padding: "4px 12px", fontFamily: "inherit", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
            입력하기
          </button>
        </div>
      )}

      {/* Today summary bar */}
      {(todayFoodTotal > 0 || todayBurned > 0) && (
        <div style={{ background: "#111800", borderBottom: `1px solid #1e2800`, padding: "12px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <div style={{ display: "flex", gap: 16 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: C.accent }}>섭취 {todayFoodTotal.toLocaleString()}</span>
              {todayBurned > 0 && <span style={{ fontSize: 12, fontWeight: 700, color: C.purple }}>소모 {todayBurned.toLocaleString()}</span>}
              {todayBurned > 0 && <span style={{ fontSize: 12, fontWeight: 700, color: C.orange }}>순 {(todayFoodTotal - todayBurned).toLocaleString()}</span>}
            </div>
            <span style={{ fontSize: 11, color: C.muted }}>목표 {DAILY_GOAL.toLocaleString()} kcal</span>
          </div>
          <div style={{ height: 5, background: C.border, borderRadius: 99, overflow: "hidden", position: "relative" }}>
            <div style={{ position: "absolute", height: "100%", width: `${Math.min(todayFoodGoalPct, 100)}%`, background: C.accent, borderRadius: 99 }} />
            {todayBurned > 0 && (
              <div style={{ position: "absolute", height: "100%", width: `${Math.min((todayBurned / DAILY_GOAL) * 100, 100)}%`, background: C.purple, opacity: 0.5, borderRadius: 99 }} />
            )}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 10, color: C.muted }}>
            <span>오늘 {todayFoodRecords.length}끼</span>
            <span>{todayFoodGoalPct}% 섭취{todayBurned > 0 ? ` · 🔥${todayBurned} 소모` : ""}</span>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, padding: "0 20px" }}>
        {TABS.map(tab => {
          const active = view === tab.key || (tab.key === "upload" && view === "result");
          return (
            <button key={tab.key} onClick={() => { setView(tab.key); setSelectedDay(null); }}
              style={{ background: "transparent", border: "none", borderBottom: active ? `2px solid ${C.accent}` : "2px solid transparent", color: active ? C.accent : C.muted, fontFamily: "inherit", fontSize: 12, fontWeight: 600, padding: "12px 14px 10px", cursor: "pointer", letterSpacing: 0.3, marginBottom: -1 }}>
              {tab.label}
            </button>
          );
        })}
      </div>

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px 20px" }}>

        {/* ── UPLOAD / RESULT ── */}
        {(view === "upload" || view === "result") && (
          <div>
            {!image ? (
              <div onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
                onDrop={e => { e.preventDefault(); setDragOver(false); processFile(e.dataTransfer.files[0]); }}
                onClick={() => fileRef.current.click()}
                style={{ border: `2px dashed ${dragOver ? C.accent : C.border}`, borderRadius: 8, padding: "60px 40px", textAlign: "center", cursor: "pointer", transition: "all 0.2s", background: dragOver ? "#1a2600" : C.surface }}>
                <div style={{ fontSize: 44, marginBottom: 14 }}>📷</div>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>식사 사진을 올려주세요</div>
                <div style={{ fontSize: 13, color: C.muted, marginBottom: 24 }}>드래그 앤 드롭 또는 클릭하여 업로드</div>
                <div style={{ display: "inline-block", background: C.accent, color: "#000", padding: "10px 28px", fontWeight: 700, fontSize: 13, letterSpacing: 1, borderRadius: 4 }}>파일 선택</div>
                <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={e => processFile(e.target.files[0])} />
              </div>
            ) : (
              <div>
                {view === "upload" && (
                  <div>
                    <div style={{ position: "relative", borderRadius: 8, overflow: "hidden", marginBottom: 20 }}>
                      <img src={image} alt="food" style={{ width: "100%", maxHeight: 360, objectFit: "cover", display: "block" }} />
                      <button onClick={reset} style={{ position: "absolute", top: 12, right: 12, background: "rgba(0,0,0,0.7)", border: "none", color: "#fff", borderRadius: "50%", width: 32, height: 32, cursor: "pointer", fontSize: 16 }}>×</button>
                    </div>
                    <button onClick={analyze} disabled={loading}
                      style={{ width: "100%", padding: "16px", background: loading ? C.border : C.accent, color: loading ? C.muted : "#000", border: "none", borderRadius: 6, fontFamily: "inherit", fontSize: 15, fontWeight: 700, letterSpacing: 1, cursor: loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
                      {loading ? <><span style={{ display: "inline-block", width: 16, height: 16, border: `2px solid ${C.muted}`, borderTopColor: C.accent, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />AI가 분석 중입니다...</> : "🔍 칼로리 분석하기"}
                    </button>
                    {error && <div style={{ background: "#2a1010", border: `1px solid ${C.danger}`, borderRadius: 6, padding: 16, marginTop: 16, color: C.danger, fontSize: 14 }}>⚠️ {error}</div>}
                  </div>
                )}
                {view === "result" && result && (
                  <div>
                    <EditableMealResult res={result} img={image} onUpdate={handleResultUpdate} />
                    <button onClick={reset}
                      style={{ width: "100%", marginTop: 20, padding: 14, background: "transparent", border: `1px solid ${C.border}`, color: C.muted, borderRadius: 6, fontFamily: "inherit", fontSize: 13, cursor: "pointer", letterSpacing: 1 }}
                      onMouseEnter={e => e.currentTarget.style.borderColor = C.accent}
                      onMouseLeave={e => e.currentTarget.style.borderColor = C.border}>
                      + 새 사진 분석하기
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── FOOD HISTORY ── */}
        {view === "history" && (
          <div>
            {selectedDay ? (
              <div>
                <button onClick={() => setSelectedDay(null)} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.muted, fontFamily: "inherit", fontSize: 12, padding: "6px 14px", borderRadius: 4, cursor: "pointer", marginBottom: 20, letterSpacing: 1 }}>← 목록으로</button>
                <div style={{ fontSize: 20, fontWeight: 700, color: selectedDay === todayKey ? C.accent : C.text, marginBottom: 4 }}>{formatDateLabel(selectedDay)}</div>
                <div style={{ fontSize: 12, color: C.muted, marginBottom: 20 }}>{(groupedFood[selectedDay]||[]).length}끼 기록</div>
                {(() => {
                  const records = groupedFood[selectedDay] || [];
                  const total = records.reduce((s,r) => s + r.result.total_calories, 0);
                  const totalP = records.reduce((s,r) => s + r.result.total_protein, 0);
                  const totalCb = records.reduce((s,r) => s + r.result.total_carbs, 0);
                  const totalF = records.reduce((s,r) => s + r.result.total_fat, 0);
                  const dayWorkoutBurned = workoutHistory.filter(w => toDateKey(w.time) === selectedDay).reduce((s,w) => s+w.burnedKcal, 0);
                  return (
                    <div>
                      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "24px", marginBottom: 16 }}>
                        <div style={{ fontSize: 11, color: C.muted, letterSpacing: 2, marginBottom: 6 }}>하루 총 섭취</div>
                        <div style={{ fontSize: 52, fontWeight: 700, color: C.accent, lineHeight: 1 }}>{total.toLocaleString()}</div>
                        <div style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>kcal</div>
                        <CalBar val={total} burned={dayWorkoutBurned} />
                        <div style={{ display: "flex", justifyContent: "space-around", marginTop: 20, paddingTop: 16, borderTop: `1px solid ${C.border}` }}>
                          <Macro label="단백질" val={totalP} color={C.blue} />
                          <Macro label="탄수화물" val={totalCb} color={C.orange} />
                          <Macro label="지방" val={totalF} color={C.red} />
                        </div>
                        {dayWorkoutBurned > 0 && (
                          <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                            <span style={{ color: C.muted }}>운동 소모</span>
                            <span style={{ color: C.purple, fontWeight: 700 }}>-{dayWorkoutBurned.toLocaleString()} kcal</span>
                          </div>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: C.muted, letterSpacing: 2, marginBottom: 12 }}>식사 목록 <span style={{ color: C.accentDim, fontSize: 10 }}>▼ 클릭하여 수정</span></div>
                      {records.map(record => {
                        const [expanded, setExpanded] = useState(false);
                        const [editingIdx, setEditingIdx] = useState(null);
                        const [localRes, setLocalRes] = useState(record.result);
                        const handleSave = async (idx, updated) => {
                          const newDishes = localRes.dishes.map((d, i) => i === idx ? updated : d);
                          const newRes = { ...localRes, dishes: newDishes, ...recalcTotals(newDishes) };
                          setLocalRes(newRes); setEditingIdx(null);
                          await handleRecordUpdate(record.id, newRes);
                        };
                        const handleDeleteDish = async (idx) => {
                          const newDishes = localRes.dishes.filter((_, i) => i !== idx);
                          const newRes = { ...localRes, dishes: newDishes, ...recalcTotals(newDishes) };
                          setLocalRes(newRes);
                          await handleRecordUpdate(record.id, newRes);
                        };
                        return (
                          <div key={record.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden", marginBottom: 10 }}>
                            <div style={{ display: "flex", alignItems: "center", cursor: "pointer" }} onClick={() => setExpanded(e => !e)}>
                              <img src={record.image} alt="" style={{ width: 72, height: 72, objectFit: "cover", flexShrink: 0 }} />
                              <div style={{ flex: 1, padding: "10px 14px" }}>
                                <div style={{ fontSize: 11, color: C.muted, marginBottom: 3 }}>{localRes.meal_type} · {formatTime(record.time)}</div>
                                <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{localRes.dishes?.map(d => d.name).join(", ") || "음식"}</div>
                                <div style={{ display: "flex", gap: 10, marginTop: 6, fontSize: 11 }}>
                                  <span style={{ color: C.blue }}>P {localRes.total_protein}g</span>
                                  <span style={{ color: C.orange }}>C {localRes.total_carbs}g</span>
                                  <span style={{ color: C.red }}>F {localRes.total_fat}g</span>
                                </div>
                              </div>
                              <div style={{ padding: "0 8px", textAlign: "right", flexShrink: 0 }}>
                                <div style={{ fontSize: 20, fontWeight: 700, color: C.accent }}>{localRes.total_calories}</div>
                                <div style={{ fontSize: 10, color: C.muted }}>kcal</div>
                              </div>
                              <div style={{ padding: "0 12px", color: C.muted, fontSize: 12 }}>{expanded ? "▲" : "▼"}</div>
                            </div>
                            {expanded && (
                              <div style={{ borderTop: `1px solid ${C.border}`, padding: "14px" }}>
                                {localRes.dishes?.map((dish, i) => {
                                  const [editThis, setEditThis] = useState(false);
                                  return (
                                    <DishRow key={i} dish={dish} editing={editThis}
                                      onEdit={() => setEditThis(true)}
                                      onSave={u => handleSave(i, u)}
                                      onCancel={() => setEditThis(false)}
                                      onDelete={() => handleDeleteDish(i)} />
                                  );
                                })}
                                <button onClick={() => deleteRecord(record.id)}
                                  style={{ width: "100%", marginTop: 8, padding: "8px", background: "transparent", border: `1px solid #3a1010`, color: C.danger, fontFamily: "inherit", fontSize: 12, cursor: "pointer", borderRadius: 5 }}>
                                  이 식사 삭제
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            ) : foodHistory.length === 0 ? (
              <div style={{ textAlign: "center", padding: "80px 0", color: C.muted }}>
                <div style={{ fontSize: 40, marginBottom: 16 }}>🍽</div>
                <div style={{ fontSize: 15 }}>아직 식사 기록이 없습니다</div>
              </div>
            ) : (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                  <div style={{ fontSize: 11, color: C.muted, letterSpacing: 2 }}>날짜별 기록</div>
                  <button onClick={async () => { if (window.confirm("모든 식사 기록을 삭제할까요?")) { setFoodHistory([]); try { await window.storage.delete(FOOD_KEY); } catch (_) {} } }}
                    style={{ background: "transparent", border: `1px solid #3a1010`, color: C.danger, fontFamily: "inherit", fontSize: 11, padding: "4px 12px", borderRadius: 4, cursor: "pointer" }}>
                    전체 삭제
                  </button>
                </div>
                {sortedFoodDates.map(dateKey => {
                  const records = groupedFood[dateKey];
                  const dayTotal = records.reduce((s, r) => s + r.result.total_calories, 0);
                  const dayBurnedKcal = workoutHistory.filter(w => toDateKey(w.time) === dateKey).reduce((s,w) => s+w.burnedKcal, 0);
                  const netCal = dayTotal - dayBurnedKcal;
                  const pct = Math.min(Math.round((netCal / DAILY_GOAL) * 100), 100);
                  const over = netCal > DAILY_GOAL;
                  const barColor = over ? C.danger : pct > 80 ? C.orange : C.accent;
                  const isToday = dateKey === todayKey;
                  return (
                    <div key={dateKey} onClick={() => setSelectedDay(dateKey)}
                      style={{ background: C.card, border: `1px solid ${isToday ? C.accentDim : C.border}`, borderRadius: 10, padding: "16px 18px", marginBottom: 10, cursor: "pointer", transition: "border-color 0.15s" }}
                      onMouseEnter={e => e.currentTarget.style.borderColor = C.accent}
                      onMouseLeave={e => e.currentTarget.style.borderColor = isToday ? C.accentDim : C.border}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          {isToday && <span style={{ background: C.accent, color: "#000", fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 3, letterSpacing: 1 }}>TODAY</span>}
                          <span style={{ fontSize: 14, fontWeight: 700, color: isToday ? C.accent : C.text }}>{formatDateLabel(dateKey)}</span>
                          <span style={{ fontSize: 11, color: C.muted }}>{records.length}끼</span>
                        </div>
                        <span style={{ fontSize: 10, color: C.muted }}>→</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 10 }}>
                        <div>
                          <span style={{ fontSize: 32, fontWeight: 700, color: over ? C.danger : C.accent, lineHeight: 1 }}>{dayTotal.toLocaleString()}</span>
                          <span style={{ fontSize: 12, color: C.muted, marginLeft: 4 }}>kcal</span>
                          {dayBurnedKcal > 0 && <span style={{ fontSize: 11, color: C.purple, marginLeft: 8 }}>🔥-{dayBurnedKcal}</span>}
                        </div>
                      </div>
                      <div style={{ height: 4, background: C.border, borderRadius: 99, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${Math.max(pct, 0)}%`, background: barColor, borderRadius: 99 }} />
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5, fontSize: 10, color: C.muted }}>
                        <span>목표 {DAILY_GOAL.toLocaleString()} kcal 기준 {Math.max(pct,0)}%</span>
                        {over && <span style={{ color: C.danger }}>+{(netCal - DAILY_GOAL).toLocaleString()} 초과</span>}
                      </div>
                      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                        {records.slice(0, 5).map(r => (
                          <img key={r.id} src={r.image} alt="" style={{ width: 38, height: 38, borderRadius: 5, objectFit: "cover", border: `1px solid ${C.border}` }} />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── WORKOUT TAB ── */}
        {view === "workout" && (
          <WorkoutTab
            workoutHistory={workoutHistory}
            setWorkoutHistory={setWorkoutHistory}
            saveWorkoutHistory={saveWorkoutHistory}
          />
        )}
      </div>

      <style>{`@keyframes spin{to{transform:rotate(360deg)}}*{box-sizing:border-box}body{margin:0}input[type=number]::-webkit-inner-spin-button{opacity:1}`}</style>
    </div>
  );
}
