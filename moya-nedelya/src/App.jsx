import { useState, useEffect, useRef } from "react";

// ---------- window.storage: в артефактах Claude это встроенный API, вне них его нет.
// Здесь — совместимый shim поверх localStorage с тем же интерфейсом (async get/set по ключу),
// поэтому вся остальная логика хранения (persist, loadAndRoll, миграции) не менялась ни на строку.
if (typeof window !== "undefined" && !window.storage) {
  window.storage = {
    get: async (key) => {
      try {
        const v = localStorage.getItem(key);
        return v === null ? null : { key, value: v };
      } catch (e) { return null; } // приватный режим Safari иногда блокирует доступ
    },
    set: async (key, value) => {
      try {
        localStorage.setItem(key, value);
        return { key, value };
      } catch (e) { console.error("localStorage недоступен:", e); return null; }
    },
  };
}

// ---------- Утилиты ----------
const pad = (n) => String(n).padStart(2, "0");
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const mondayOf = (d) => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const DAY_NAMES = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const DAY_FULL = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];
const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const LAST = 6; // индекс последнего дня недели (Вс)
const uid = () => Math.random().toString(36).slice(2, 10);
const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const toHHMM = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const addHour = (t) => toHHMM(Math.min(toMin(t) + 60, 23 * 60 + 59));
const fmtLeft = (m) => m >= 60 ? `${Math.floor(m / 60)} ч ${Math.round(m % 60)} мин` : m >= 1 ? `${Math.round(m)} мин` : "меньше минуты";
function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}

// ---------- Матрица Эйзенхауэра: важность × срочность ----------
const CATS = {
  iu: { label: "Важно срочно",      full: "Важное и срочное",      color: "#E5484D" },
  in: { label: "Важно не срочно",   full: "Важное, не срочное",    color: "#F5A524" },
  nu: { label: "Неважно и срочно",  full: "Неважное и срочное",    color: "#EAB308" },
  nn: { label: "Мелочь",            full: "Не важное, не срочное", color: "#22C55E" },
};
const CAT_ORDER = ["iu", "in", "nu", "nn"];
const catKey = (k) => (CATS[k] ? k : "in");   // старые ярлыки (Работа/Отдых/Личное) → «Важно»
const cat_ = (k) => CATS[catKey(k)];
const STUCK = 3;        // столько переносов = дело застряло
const RING_W = 2.5;    // толщина кольца прогресса на капсуле дня
const NOTE_MAX = 15;   // символов в заметке, пробелы не в счёт
const noteLen = (v) => (v || "").replace(/\s/g, "").length;
const MAX_EXT = 2;      // не больше двух продлений
const EXT_MIN = 10;     // по 10 минут

// ---------- Настройки ----------
const DEFAULT_SETTINGS = {
  theme: "dark",         // 'dark' | 'light' | 'system'
  accent: "green",       // 'green' | 'violet' | 'cream'
  workStart: "09:00",
  workEnd: "20:00",
  defaultDuration: 60,   // минут, когда конец не указан
  notifyLead: 10,        // за сколько минут напоминать
  timeFormat: 24,        // 24 | 12
  reviewTime: "",        // "" — выкл, иначе "HH:MM" фиксированное время напоминания об итогах
};
const ACCENT_PRESETS = {
  green:  { acc: "#EC4E20", acc2: "#FFA552", ctaText: "#FFFFFF", accLight: "#FF7A55" },
  violet: { acc: "#8B5CF6", acc2: "#EC4E20", ctaText: "#F5F5F5" },
  cream:  { acc: "#BAFA20", acc2: "#C9B4F5", ctaText: "#141416" },
};
const THEME_PRESETS = {
  dark:  { bg: "#141416", card: "#1E1E21", card2: "#26262A", line: "#2C2C30", text: "#F5F5F5", muted: "#9B9B9E", modal: "#1C1C1F", overlay: "rgba(30,30,33,.92)", track: "#2A2A2E", line2: "#3A3A3F", cs: "dark",
           glass: "rgba(30,30,33,.55)", glassBrd: "rgba(255,255,255,.10)", sheen: "rgba(255,255,255,.13)" },
  light: { bg: "#F3F2EE", card: "#FFFFFF", card2: "#EBEAE5", line: "#E1E0DA", text: "#17171A", muted: "#6C6C70", modal: "#FFFFFF", overlay: "rgba(255,255,255,.92)", track: "#E4E3DC", line2: "#C7C6BF", cs: "light",
           glass: "rgba(255,255,255,.58)", glassBrd: "rgba(255,255,255,.75)", sheen: "rgba(255,255,255,.85)" },
};
const hexToRgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
const addMinutes = (t, mins) => toHHMM(Math.min(toMin(t) + mins, 23 * 60 + 59));
const hasOverlap = (list, from, to, excludeId) => {
  const s = toMin(from), e = toMin(to);
  const hit = (list || []).find((t) => t.id !== excludeId && s < toMin(t.to) && e > toMin(t.from));
  return hit || null;
};
// Числительные для голосового ввода: «с девяти до десяти» -> «с 9 до 10»
const RU_ONES = { "ноль":0,"один":1,"одна":1,"одну":1,"два":2,"две":2,"три":3,"четыре":4,"пять":5,"шесть":6,"семь":7,"восемь":8,"девять":9 };
const RU_TEENS = { "десять":10,"одиннадцать":11,"двенадцать":12,"тринадцать":13,"четырнадцать":14,"пятнадцать":15,"шестнадцать":16,"семнадцать":17,"восемнадцать":18,"девятнадцать":19 };
const RU_TENS = { "двадцать":20,"тридцать":30,"сорок":40,"пятьдесят":50 };
const RU_ALL = { ...RU_ONES, ...RU_TEENS, ...RU_TENS };
function wordsToDigitsRu(text) {
  const words = text.split(/(\s+)/);
  const out = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i].toLowerCase();
    if (RU_TENS[w] && words[i + 2] && RU_ONES[words[i + 2].toLowerCase()] !== undefined) {
      out.push(String(RU_TENS[w] + RU_ONES[words[i + 2].toLowerCase()]));
      i += 3; continue;
    }
    if (RU_ALL[w] !== undefined) { out.push(String(RU_ALL[w])); i += 1; continue; }
    out.push(words[i]); i += 1;
  }
  return out.join("");
}
const fmtTime = (t, fmt) => {
  if (!t) return t;
  if (fmt !== 12) return t;
  const [h, m] = t.split(":").map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
};

// Голос: «с 10 до 11 тренировка»
function parseVoice(text) {
  const re = /с\s*(\d{1,2})(?:[:. ](\d{2}))?\s*(?:до|по)\s*(\d{1,2})(?:[:. ](\d{2}))?/i;
  let m = text.match(re);
  let source = text; // из какой строки вырезаем заголовок
  if (!m) {
    const digitized = wordsToDigitsRu(text);
    m = digitized.match(re);
    if (m) source = digitized;
  }
  if (!m) return { title: text.trim(), from: "", to: "" };
  return {
    title: source.replace(re, "").replace(/\s{2,}/g, " ").trim(),
    from: `${pad(+m[1])}:${m[2] || "00"}`,
    to: `${pad(+m[3])}:${m[4] || "00"}`,
  };
}

// ---------- Иконки (SVG, монохром) ----------
const I = {
  cal: () => (<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="17" rx="3"/><path d="M8 2v4M16 2v4M3 10h18"/></svg>),
  rep: () => (<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m17 1 4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="m7 23-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>),
  bell: () => (<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>),
  bellOff: () => (<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8.6 3a6 6 0 0 1 9.4 5c0 4 1 6 2 7H9"/><path d="M6 8c0 7-3 9-3 9h11"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/><line x1="2" y1="2" x2="22" y2="22"/></svg>),
  mic: () => (<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 19v3"/></svg>),
  stop: () => (<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>),
  list: () => (<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.3" fill="currentColor" stroke="none"/></svg>),
  grid: () => (<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/></svg>),
  chart: () => (<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="6" y1="20" x2="6" y2="12"/><line x1="12" y1="20" x2="12" y2="5"/><line x1="18" y1="20" x2="18" y2="15"/></svg>),
  gear: () => (<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>),
  down: () => (<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v13"/><path d="m6 11 6 6 6-6"/><path d="M4 21h16"/></svg>),
  up: () => (<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21V8"/><path d="m6 13 6-6 6 6"/><path d="M4 3h16"/></svg>),
  chevL: () => (<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>),
  chevR: () => (<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6"/></svg>),
  check2: () => (<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>),
  spark: () => (<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/></svg>),
  filter: () => (<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18M6 12h12M10 19h4"/></svg>),
  note: () => (<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h13M4 11h13M4 16h8"/><path d="m17.5 18.5 3-3 1.5 1.5-3 3-2 .5z"/></svg>),
};

// ---------- Приложение ----------
function WeekPlanner() {
  const emptyDays = () => ({ 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] });
  const [days, setDays] = useState(emptyDays());
  const [backlog, setBacklog] = useState([]);
  const [closed, setClosed] = useState({});
  const [loaded, setLoaded] = useState(false);

  const today = new Date();
  const todayIdx = (today.getDay() + 6) % 7; // Пн=0 … Вс=6
  const currentMonday = mondayOf(today);
  const currentWeekKey = dateKey(currentMonday);
  const [weeks, setWeeks] = useState({});           // { mondayKey: {days,backlog,closed,routinesApplied} } — все прочие недели
  const [viewMondayKey, setViewMondayKey] = useState(currentWeekKey); // какая неделя открыта
  const [showCalendar, setShowCalendar] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [calMonth, setCalMonth] = useState(() => { const d = mondayOf(new Date()); d.setDate(1); return d; });
  const [sel, setSel] = useState(todayIdx);
  const [filter, setFilter] = useState("all");
  const [view, setView] = useState("day"); // 'day' | 'grid' | 'stats'
  const [routines, setRoutines] = useState([]);      // повторяющиеся дела
  const [applied, setApplied] = useState([]);        // id повторов, уже применённых на этой неделе
  const [history, setHistory] = useState({});        // 'YYYY-MM-DD' -> {done, total} для стрика
  const [showRoutines, setShowRoutines] = useState(false);
  const [notifOn, setNotifOn] = useState(false);
  const notifiedRef = useRef({});
  const [rTitle, setRTitle] = useState("");
  const [rFrom, setRFrom] = useState("");
  const [rTo, setRTo] = useState("");
  const [rCat, setRCat] = useState("other");
  const [rDays, setRDays] = useState([0, 1, 2, 3, 4]);

  const [now, setNow] = useState(new Date());
  const [review, setReview] = useState(null);
  const [title, setTitle] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [cat, setCat] = useState("in");
  const [listening, setListening] = useState(false);
  const [voiceErr, setVoiceErr] = useState("");
  const recRef = useRef(null);
  const inputRef = useRef(null);


  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null); // 'week' | 'all'
  const [settingsMsg, setSettingsMsg] = useState("");
  const [systemDark, setSystemDark] = useState(true);
  const fileInputRef = useRef(null);

  const [toast, setToast] = useState(null); // { msg, action?: { label, onClick } }
  const toastTimerRef = useRef(null);
  const showToast = (msg, action) => {
    clearTimeout(toastTimerRef.current);
    setToast({ msg, action });
    toastTimerRef.current = setTimeout(() => setToast(null), 5500);
  };

  const [swipe, setSwipe] = useState(null);       // { id, dx }
  const swipeRef = useRef(null);
  const weekRef = useRef(null);
  const [capSize, setCapSize] = useState({ w: 46, h: 84 });
  const [editFor, setEditFor] = useState(null);
  const [eTitle, setETitle] = useState("");
  const [eFrom, setEFrom] = useState("");
  const [eTo, setETo] = useState("");
  const [eDay, setEDay] = useState(0);   // на какой день переносим при редактировании
  const [eNote, setENote] = useState("");
  const [eCat, setECat] = useState("other");
  const [noteFocus, setNoteFocus] = useState(false);

  // Кольцо рисуется в реальных пикселях капсулы: иначе SVG растягивается
  // и линия выходит неровной по толщине и скруглениям.
  useEffect(() => {
    const el = weekRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const c = el.children[0];
      if (c && c.offsetWidth) setCapSize({ w: c.offsetWidth, h: c.offsetHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [view]);
  const mountedDateRef = useRef(dateKey(new Date()));
  const rolloverCheckRef = useRef(() => {});

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(mq.matches);
    const l = (e) => setSystemDark(e.matches);
    mq.addEventListener ? mq.addEventListener("change", l) : mq.addListener(l);
    return () => (mq.removeEventListener ? mq.removeEventListener("change", l) : mq.removeListener(l));
  }, []);

  const monday = (() => { const [y, m, d] = viewMondayKey.split("-").map(Number); return new Date(y, m - 1, d); })();
  const weekKey = viewMondayKey;
  const isCurrentWeek = viewMondayKey === currentWeekKey;
  const dayDate = (i) => { const d = new Date(monday); d.setDate(d.getDate() + i); return d; };
  const mondayKeyOffset = (key, deltaWeeks) => { const [y, m, d] = key.split("-").map(Number); const dt = new Date(y, m - 1, d); dt.setDate(dt.getDate() + deltaWeeks * 7); return dateKey(dt); };

  // Тик времени. Ререндер только когда меняется минута (или идёт активное дело — тогда посекундно
  // для плавной шкалы). Иначе каждую секунду перерисовывалось бы всё дерево — отсюда были лаги.
  const hasActiveRef = useRef(false);
  useEffect(() => {
    const id = setInterval(() => {
      rolloverCheckRef.current();
      setNow((prev) => {
        const n = new Date();
        if (hasActiveRef.current) return n;                       // есть текущее дело — тикаем посекундно
        if (n.getMinutes() !== prev.getMinutes()) return n;       // иначе — только при смене минуты
        return prev;                                              // тот же объект → React пропускает ререндер
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Разложить повторы по дням недели (только те, что ещё не применены)
  const applyRoutines = (d, rl, ap, startIdx = 0) => {
    const dd = { ...d };
    const newApplied = [...ap];
    rl.forEach((r) => {
      if (newApplied.includes(r.id)) return;
      (r.days || []).forEach((i) => {
        if (i < startIdx) return;
        dd[i] = [...(dd[i] || []), { id: uid(), routineId: r.id, title: r.title, from: r.from, to: r.to, cat: r.cat, done: false, carried: false }]
          .sort((a, b) => toMin(a.from) - toMin(b.from));
      });
      newApplied.push(r.id);
    });
    return { dd, newApplied };
  };

  // Пустой каркас одной недели
  const blankWeek = () => ({ days: emptyDays(), backlog: [], closed: {}, routinesApplied: [] });
  // Материализуем повторы в неделю, если каких-то ещё нет
  const ensureWeek = (wk, key, rl) => {
    const base = wk || blankWeek();
    const { dd, newApplied } = applyRoutines({ ...emptyDays(), ...base.days }, rl, base.routinesApplied || []);
    return { days: dd, backlog: base.backlog || [], closed: base.closed || {}, routinesApplied: newApplied };
  };

  const saveStore = (allWeeks, rl, h, no, st) =>
    window.storage.set("myday:v3", JSON.stringify({ weeks: allWeeks, routines: rl, history: h, notifOn: no, settings: st }))
      .catch((e) => console.error("Сохранение не удалось:", e));

  // Загрузка всего архива недель (+ разовая миграция со старого однонедельного формата).
  const loadAndRoll = async () => {
    const wkNow = dateKey(mondayOf(new Date()));
    let store = null;
    try {
      const res = await window.storage.get("myday:v3");
      if (res && res.value) store = JSON.parse(res.value);
    } catch (e) { /* нет нового формата */ }

    // Разовая миграция из myday:week2
    if (!store) {
      try {
        const old = await window.storage.get("myday:week2");
        if (old && old.value) {
          const d = JSON.parse(old.value);
          const w = {};
          if (d.weekKey) w[d.weekKey] = { days: { ...emptyDays(), ...d.days }, backlog: d.backlog || [], closed: d.closed || {}, routinesApplied: d.routinesApplied || [] };
          // старый «перенос на след. неделю» кладём в понедельник следующей недели
          if (d.weekKey && (d.nextWeek || []).length) {
            const nk = mondayKeyOffset(d.weekKey, 1);
            w[nk] = { days: { ...emptyDays(), 0: d.nextWeek.map((t) => ({ ...t, done: false, carried: true })) }, backlog: [], closed: {}, routinesApplied: [] };
          }
          store = { weeks: w, routines: d.routines || [], history: d.history || {}, notifOn: !!d.notifOn, settings: d.settings || {} };
        }
      } catch (e) { /* миграции нет */ }
    }

    const rl = (store && store.routines) || [];
    const h = (store && store.history) || {};
    const no = !!(store && store.notifOn) && typeof Notification !== "undefined" && Notification.permission === "granted";
    const st = { ...DEFAULT_SETTINGS, ...((store && store.settings) || {}) };
    const allWeeks = (store && store.weeks) || {};
    // Гарантируем существование текущей недели с материализованными повторами
    allWeeks[wkNow] = ensureWeek(allWeeks[wkNow], wkNow, rl);

    setRoutines(rl); setHistory(h); setNotifOn(no); setSettings(st);
    setWeeks(allWeeks);
    // Открываем текущую неделю
    const cur = allWeeks[wkNow];
    setViewMondayKey(wkNow);
    setDays(cur.days); setBacklog(cur.backlog); setClosed(cur.closed); setApplied(cur.routinesApplied);
    setSel((new Date().getDay() + 6) % 7);
    saveStore(allWeeks, rl, h, no, st);
    setLoaded(true);
  };

  useEffect(() => { loadAndRoll(); }, []);

  useEffect(() => {
    const anyOpen = showSettings || showRoutines || showCalendar || !!review || !!editFor;
    if (!anyOpen) return;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (showSettings) setShowSettings(false);
      else if (showRoutines) setShowRoutines(false);
      else if (showCalendar) setShowCalendar(false);
      else if (review) setReview(null);
      else if (editFor) setEditFor(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSettings, showRoutines, showCalendar, review, editFor]);

  // Каждую секунду проверяем: не наступил ли новый день, пока вкладка открыта.
  // Ref всегда указывает на свежую версию — иначе setInterval «застрял» бы на дате монтирования.
  rolloverCheckRef.current = () => {
    const k = dateKey(new Date());
    if (k !== mountedDateRef.current) {
      mountedDateRef.current = k;
      loadAndRoll();
    }
  };

  // Сворачиваем текущую рабочую копию (days/backlog/closed/applied) в архив недель и сохраняем весь стор.
  // Доп. аргумент extraWeeks позволяет за одну запись обновить и другую неделю (перенос Вс→Пн).
  const persist = (d = days, b = backlog, c = closed, ap = applied, rl = routines, h = history, no = notifOn, st = settings, extraWeeks = null) => {
    const merged = { ...weeks, [viewMondayKey]: { days: d, backlog: b, closed: c, routinesApplied: ap }, ...(extraWeeks || {}) };
    setWeeks(merged);
    saveStore(merged, rl, h, no, st);
  };
  const setDayTasks = (idx, list) => {
    const d = { ...days, [idx]: [...list].sort((a, b) => toMin(a.from) - toMin(b.from)) };
    setDays(d); persist(d);
  };

  // Переключение на другую неделю: сворачиваем текущую в архив, гидрируем целевую (создаём при необходимости)
  const switchWeek = (targetKey) => {
    const merged = { ...weeks, [viewMondayKey]: { days, backlog, closed, routinesApplied: applied } };
    const tgt = ensureWeek(merged[targetKey], targetKey, routines);
    merged[targetKey] = tgt;
    setWeeks(merged);
    setViewMondayKey(targetKey);
    setDays(tgt.days); setBacklog(tgt.backlog); setClosed(tgt.closed); setApplied(tgt.routinesApplied);
    setSel(targetKey === currentWeekKey ? (new Date().getDay() + 6) % 7 : 0);
    setFilter("all"); setShowFilters(false);
    saveStore(merged, routines, history, notifOn, settings);
  };
  const goToday = () => switchWeek(currentWeekKey);

  // ---------- Добавление ----------
  const addTask = (t = title, f = from, e = to, dayIdx = sel, c = cat) => {
    const name = (t || "").trim();
    if (!name) return;
    if (!f) {
      // Без времени — ставим на ближайший свободный слот в рабочих часах выбранного дня
      const dur = settings.defaultDuration;
      const lo = toMin(settings.workStart), hi = toMin(settings.workEnd);
      const nowM = now.getHours() * 60 + now.getMinutes();
      let slot = null;
      for (let x = lo; x + dur <= hi; x += 15) {
        if (selIsToday && x < nowM) continue;
        if (!hasOverlap(days[dayIdx], toHHMM(x), toHHMM(x + dur), null)) { slot = x; break; }
      }
      if (slot === null) slot = Math.min(hi - dur, Math.max(lo, nowM));
      const nf = toHHMM(slot), nt = toHHMM(slot + dur);
      setDayTasks(dayIdx, [...days[dayIdx], { id: uid(), title: name, from: nf, to: nt, cat: c, done: false, carried: false }]);
      showToast(`Поставлено на ${fmtTime(nf, settings.timeFormat)}`);
    } else {
      const end = e && toMin(e) > toMin(f) ? e : addMinutes(f, settings.defaultDuration);
      const clash = hasOverlap(days[dayIdx], f, end, null);
      setDayTasks(dayIdx, [...days[dayIdx], { id: uid(), title: name, from: f, to: end, cat: c, done: false, carried: false }]);
      if (clash) showToast(`Пересекается с «${clash.title}» — добавлено всё равно`);
    }
    setTitle(""); setFrom(""); setTo("");
  };

  const startVoice = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setVoiceErr("Голосовой ввод не поддерживается в этом браузере"); return; }
    setVoiceErr("");
    const rec = new SR(); recRef.current = rec;
    rec.lang = "ru-RU"; rec.interimResults = false;
    rec.onresult = (ev) => {
      const p = parseVoice(ev.results[0][0].transcript);
      if (p.from) addTask(p.title, p.from, p.to);
      else { setTitle(p.title); inputRef.current && inputRef.current.focus(); }
    };
    rec.onerror = (ev) => setVoiceErr(ev.error === "not-allowed" ? "Нет доступа к микрофону" : "Не расслышал, попробуй ещё раз");
    rec.onend = () => setListening(false);
    setListening(true); rec.start();
  };
  const stopVoice = () => { recRef.current && recRef.current.stop(); };

  // ---------- Уведомления «через N минут — следующее дело» ----------
  const toggleNotif = async () => {
    setImportErr("");
    if (notifOn) { setNotifOn(false); persist(days, backlog, closed, applied, routines, history, false); return; }
    if (typeof Notification === "undefined") { setImportErr("Уведомления не поддерживаются в этом окружении (заработают после деплоя на сайт)."); return; }
    const p = await Notification.requestPermission();
    if (p !== "granted") { setImportErr("Разрешение на уведомления не выдано."); return; }
    setNotifOn(true); persist(days, backlog, closed, applied, routines, history, true);
  };

  useEffect(() => {
    if (!notifOn || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const nm = now.getHours() * 60 + now.getMinutes();
    (days[todayIdx] || []).forEach((t) => {
      if (t.done) return;
      const lead = toMin(t.from) - nm;
      if (lead > 0 && lead <= settings.notifyLead && !notifiedRef.current[t.id]) {
        notifiedRef.current[t.id] = true;
        try { new Notification(`Скоро: ${t.title}`, { body: `Начало в ${t.from} — через ${lead} мин` }); } catch (e) { /* noop */ }
      }
    });
  }, [now, notifOn]);

  // ---------- Повторяющиеся дела ----------
  const addRoutine = () => {
    const name = rTitle.trim();
    if (!name || !rFrom || !rDays.length) return;
    const r = {
      id: uid(), title: name, cat: rCat, from: rFrom,
      to: rTo && toMin(rTo) > toMin(rFrom) ? rTo : addMinutes(rFrom, settings.defaultDuration),
      days: [...rDays].sort((a, b) => a - b),
    };
    const rl = [...routines, r];
    const startIdx = isCurrentWeek ? todayIdx : 0;
    const { dd, newApplied } = applyRoutines(days, [r], applied, startIdx);
    setRoutines(rl); setDays(dd); setApplied(newApplied);
    persist(dd, backlog, closed, newApplied, rl);
    setRTitle(""); setRFrom(""); setRTo("");
  };
  const delRoutine = (id) => {
    const rl = routines.filter((r) => r.id !== id);
    setRoutines(rl); persist(days, backlog, closed, applied, rl);
  };

  // ---------- Перенос дела перетаскиванием в сетке ----------
  const moveTask = (id, fromIdx, toIdx, nf, nt) => {
    const task = (days[fromIdx] || []).find((t) => t.id === id);
    if (!task) return;
    const destList = fromIdx === toIdx ? (days[toIdx] || []).filter((t) => t.id !== id) : (days[toIdx] || []);
    const clash = hasOverlap(destList, nf, nt, id);
    const d = { ...days };
    d[fromIdx] = d[fromIdx].filter((t) => t.id !== id);
    d[toIdx] = [...d[toIdx], { ...task, from: nf, to: nt }].sort((a, b) => toMin(a.from) - toMin(b.from));
    setDays(d); persist(d);
    if (clash) showToast(`Пересекается с «${clash.title}»`);
  };

  // ---------- Настройки ----------
  const updateSetting = (patch) => {
    const st = { ...settings, ...patch };
    setSettings(st);
    persist(days, backlog, closed, applied, routines, history, notifOn, st);
  };

  const exportData = () => {
    const merged = { ...weeks, [viewMondayKey]: { days, backlog, closed, routinesApplied: applied } };
    const payload = { version: 3, weeks: merged, routines, history, notifOn, settings };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `moya-nedelya-${currentWeekKey}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const importData = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const rl = data.routines || [];
        const h = data.history || {};
        const st = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
        let allWeeks;
        if (data.weeks && typeof data.weeks === "object") {
          allWeeks = {}; // новый формат: архив недель
          Object.entries(data.weeks).forEach(([k, w]) => {
            allWeeks[k] = { days: { ...emptyDays(), ...(w.days || {}) }, backlog: w.backlog || [], closed: w.closed || {}, routinesApplied: w.routinesApplied || [] };
          });
        } else if (data.days && typeof data.days === "object") {
          // старый одно-недельный экспорт
          const k = data.weekKey || currentWeekKey;
          allWeeks = { [k]: { days: { ...emptyDays(), ...data.days }, backlog: data.backlog || [], closed: data.closed || {}, routinesApplied: data.routinesApplied || [] } };
        } else throw new Error("bad-shape");
        allWeeks[currentWeekKey] = ensureWeek(allWeeks[currentWeekKey], currentWeekKey, rl);
        const cur = allWeeks[currentWeekKey];
        setWeeks(allWeeks); setViewMondayKey(currentWeekKey);
        setDays(cur.days); setBacklog(cur.backlog); setClosed(cur.closed); setApplied(cur.routinesApplied);
        setSel((new Date().getDay() + 6) % 7);
        setRoutines(rl); setHistory(h); setSettings(st); setSettingsMsg("Данные загружены.");
        saveStore(allWeeks, rl, h, notifOn, st);
      } catch (e) {
        setSettingsMsg("Не удалось прочитать файл — это точно экспорт из этого приложения?");
      }
    };
    reader.readAsText(file);
  };

  const resetWeek = () => {
    if (confirmAction !== "week") { setConfirmAction("week"); return; }
    const d = emptyDays();
    setDays(d); setBacklog([]); setClosed({}); setApplied([]); setConfirmAction(null);
    setSettingsMsg("Текущая неделя очищена.");
    persist(d, [], {}, [], routines, history, notifOn, settings);
  };
  const resetAll = () => {
    if (confirmAction !== "all") { setConfirmAction("all"); return; }
    const fresh = { [currentWeekKey]: blankWeek() };
    setWeeks(fresh); setViewMondayKey(currentWeekKey);
    setDays(emptyDays()); setBacklog([]); setClosed({}); setRoutines([]); setApplied([]);
    setHistory({}); setNotifOn(false); setSettings(DEFAULT_SETTINGS); setConfirmAction(null);
    setSel((new Date().getDay() + 6) % 7);
    setSettingsMsg("Все данные сброшены.");
    saveStore(fresh, [], {}, false, DEFAULT_SETTINGS);
  };



  // ---------- Статусы ----------
  const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const todayKey = dateKey(new Date());
  // Статус дела по реальной дате его дня — корректно и для прошлых, и для будущих недель
  const status = (t, idx) => {
    const dk = dateKey(dayDate(idx));
    if (dk < todayKey) return "past";
    if (dk > todayKey) return "future";
    if (nowMin < toMin(t.from)) return "future";
    if (nowMin >= toMin(t.to)) return "past";
    return "active";
  };
  const selIsToday = dateKey(dayDate(sel)) === todayKey;

  const list = days[sel] || [];
  const shown = filter === "all" ? list : list.filter((t) => catKey(t.cat) === filter);
  const stuckToday = list.filter((t) => (t.moves || 0) >= STUCK && !t.done);
  const todayList = isCurrentWeek ? (days[todayIdx] || []) : [];
  const expired = todayList.find((t) => !t.done && !t.asked && nowMin >= toMin(t.to)) || null;
  const activeTask = selIsToday ? list.find((t) => status(t, sel) === "active") : null;
  const nextTask = selIsToday ? list.find((t) => status(t, sel) === "future") : null;
  hasActiveRef.current = !!activeTask;   // посекундный тик нужен только пока идёт дело
  const lastEnd = list.length ? Math.max(...list.map((t) => toMin(t.to))) : null;
  const dayOver = selIsToday && list.length > 0 && nowMin > lastEnd;

  const total = list.length;
  const doneN = list.filter((t) => t.done).length;
  const pct = total ? Math.round((doneN / total) * 100) : 0;
  const weekAll = Object.values(days).flat();

  // Стрик: подряд закрытые дни (через «Итоги дня»)
  const streak = (() => {
    let n = 0; const d = new Date();
    if (!history[dateKey(d)]) d.setDate(d.getDate() - 1); // сегодня ещё не закрыт — считаем со вчера
    while (history[dateKey(d)]) { n++; d.setDate(d.getDate() - 1); }
    return n;
  })();
  const catMins = {};
  CAT_ORDER.forEach((k) => {
    catMins[k] = weekAll.filter((t) => catKey(t.cat) === k)
      .reduce((s, t) => s + toMin(t.to) - toMin(t.from), 0);
  });
  const maxCat = Math.max(1, ...Object.values(catMins));

  const toggle = (id) => setDayTasks(sel, list.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  const remove = (id) => {
    const removedIdx = sel;
    const removed = list.find((t) => t.id === id);
    setDayTasks(sel, list.filter((t) => t.id !== id));
    if (removed) {
      showToast("Дело удалено", {
        label: "Отменить",
        onClick: () => setDays((d) => {
          const next = { ...d, [removedIdx]: [...(d[removedIdx] || []), removed].sort((a, b) => toMin(a.from) - toMin(b.from)) };
          persist(next);
          return next;
        }),
      });
    }
  };
  // Свайп по карточке: влево — выполнено/снять, вправо — перенести на завтра
  const startSwipe = (ev, t) => {
    if (ev.target.closest("button, input")) return;   // не мешаем кнопкам внутри карточки
    const info = { id: t.id, x0: ev.clientX, y0: ev.clientY, dx: 0, lock: null };
    swipeRef.current = info;
    const move = (e) => {
      const i = swipeRef.current; if (!i) return;
      const dx = e.clientX - i.x0, dy = e.clientY - i.y0;
      if (!i.lock && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) i.lock = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (i.lock !== "x") return;                     // вертикальный жест — это скролл, не мешаем
      i.dx = Math.max(-120, Math.min(120, dx));
      setSwipe({ id: i.id, dx: i.dx });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const i = swipeRef.current; swipeRef.current = null; setSwipe(null);
      if (!i || i.lock !== "x") return;
      if (i.dx <= -70) toggle(i.id);                  // влево — готово
      else if (i.dx >= 70) moveToNextDay(i.id);       // вправо — на завтра
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Перенос дела на следующий день (в т.ч. Вс → Пн следующей недели)
  const moveToNextDay = (id, fromIdx = sel) => {
    const src = days[fromIdx] || [];
    const t = src.find((x) => x.id === id); if (!t) return;
    const rest = src.filter((x) => x.id !== id);
    const moved = { ...t, done: false, carried: true, asked: false, ext: 0, moves: (t.moves || 0) + 1 };
    const sel = fromIdx;
    if (sel < LAST) {
      const d = { ...days, [sel]: rest, [sel + 1]: [...days[sel + 1], moved].sort((a, b) => toMin(a.from) - toMin(b.from)) };
      setDays(d); persist(d);
      showToast(`Перенесено на ${DAY_NAMES[sel + 1]}`);
    } else {
      const nk = mondayKeyOffset(viewMondayKey, 1);
      const nw = ensureWeek(weeks[nk], nk, routines);
      nw.days[0] = [...nw.days[0], moved].sort((a, b) => toMin(a.from) - toMin(b.from));
      const d = { ...days, [sel]: rest };
      setDays(d); persist(d, backlog, closed, applied, routines, history, notifOn, settings, { [nk]: nw });
      showToast("Перенесено на понедельник");
    }
  };

  const openEdit = (t, focusNote = false) => {
    setEditFor(t.id); setETitle(t.title); setEFrom(t.from); setETo(t.to);
    setENote(t.note || ""); setECat(catKey(t.cat)); setEDay(sel);
    setNoteFocus(focusNote);
  };
  const saveEdit = () => {
    const name = eTitle.trim();
    if (!name || !eFrom) { setEditFor(null); return; }
    const end = eTo && toMin(eTo) > toMin(eFrom) ? eTo : addMinutes(eFrom, settings.defaultDuration);
    const note = eNote.trim();
    const patch = { title: name, from: eFrom, to: end, cat: eCat, note: note || undefined };

    if (eDay === sel) {
      const clash = hasOverlap(list, eFrom, end, editFor);
      setDayTasks(sel, list.map((t) => (t.id === editFor ? { ...t, ...patch } : t)));
      setEditFor(null);
      if (clash) showToast(`Пересекается с «${clash.title}»`);
    } else {
      // Перенос на другой день недели — это осознанное перепланирование, а не «не успел»,
      // поэтому счётчик переносов (moves/carried) здесь не трогаем.
      const task = list.find((t) => t.id === editFor);
      const destList = days[eDay] || [];
      const clash = hasOverlap(destList, eFrom, end, editFor);
      const d = { ...days };
      d[sel] = list.filter((t) => t.id !== editFor);
      d[eDay] = [...destList, { ...task, ...patch }].sort((a, b) => toMin(a.from) - toMin(b.from));
      setDays(d); persist(d);
      setEditFor(null);
      showToast(clash ? `Перенесено на ${DAY_NAMES[eDay]} — пересекается с «${clash.title}»` : `Перенесено на ${DAY_NAMES[eDay]}`);
    }
  };

  // ---------- Продление и вопрос «успел?» ----------
  const patchTask = (id, patch, dayIdx) => {
    const l = (days[dayIdx] || []).map((t) => (t.id === id ? { ...t, ...patch } : t));
    const d = { ...days, [dayIdx]: l.sort((a, b) => toMin(a.from) - toMin(b.from)) };
    setDays(d); persist(d);
  };
  const extendTask = (t, dayIdx) => {
    const used = t.ext || 0;
    if (used >= MAX_EXT) { showToast("Продлевать больше нельзя — реши: сделано или на завтра"); return; }
    patchTask(t.id, { to: addMinutes(t.to, EXT_MIN), ext: used + 1, asked: false }, dayIdx);
    showToast(`+${EXT_MIN} мин · осталось продлений: ${MAX_EXT - used - 1}`);
  };

  // Быстрое добавление в свободный промежуток
  const quickAdd = (f, t2) => {
    setFrom(f); setTo(t2);
    if (inputRef.current) inputRef.current.focus();
    showToast(`Новое дело на ${fmtTime(f, settings.timeFormat)} — впиши название`);
  };


  // ---------- Опрос ----------
  const openReview = () => {
    const choices = {};
    list.forEach((t) => { choices[t.id] = t.done ? "done" : "tomorrow"; });
    setReview({ choices });
  };
  const confirmReview = () => {
    const stay = [], move = [];
    list.forEach((t) => {
      const c = review.choices[t.id];
      if (c === "done") stay.push({ ...t, done: true });
      else if (c === "tomorrow") move.push({ ...t, done: false, carried: true, moves: (t.moves || 0) + 1 });
    });
    const d = { ...days, [sel]: stay };
    let extra = null;
    if (sel < LAST) {
      d[sel + 1] = [...d[sel + 1], ...move].sort((a, b) => toMin(a.from) - toMin(b.from));
    } else if (move.length) {
      // Воскресенье → понедельник следующей недели: пишем прямо в архив соседней недели
      const nk = mondayKeyOffset(viewMondayKey, 1);
      const nextWk = ensureWeek(weeks[nk], nk, routines);
      nextWk.days[0] = [...nextWk.days[0], ...move].sort((a, b) => toMin(a.from) - toMin(b.from));
      extra = { [nk]: nextWk };
    }
    const c = { ...closed, [sel]: true };
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 120);
    const rawHist = { ...history, [dateKey(dayDate(sel))]: { done: stay.length, total: list.length } };
    const h = Object.fromEntries(Object.entries(rawHist).filter(([k]) => new Date(k) >= cutoff));
    setDays(d); setClosed(c); setHistory(h); setReview(null);
    persist(d, backlog, c, applied, routines, h, notifOn, settings, extra);
  };
  const reopenDay = () => { const c = { ...closed, [sel]: false }; setClosed(c); persist(days, backlog, c); };

  const selDate = dayDate(sel);
  const isClosed = !!closed[sel];

  const effTheme = settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;
  const themeVars = THEME_PRESETS[effTheme] || THEME_PRESETS.dark;
  const accentVars = ACCENT_PRESETS[settings.accent] || ACCENT_PRESETS.green;
  // Правило из UI-кита: на светлой теме акцентный текст заменяем тёмным углём (светлые заливки нечитаемы как текст).
  // На тёмной теме используем осветлённый вариант акцента (accLight), иначе тёмный индиго как текст глуховат.
  const accTextColor = effTheme === "light" ? "#17171A" : (accentVars.accLight || accentVars.acc);
  const rootVars = {
    "--bg": themeVars.bg, "--card": themeVars.card, "--card2": themeVars.card2, "--line": themeVars.line,
    "--text": themeVars.text, "--muted": themeVars.muted, "--modal": themeVars.modal,
    "--overlay": themeVars.overlay, "--cs": themeVars.cs,
    "--track": themeVars.track, "--line2": themeVars.line2,
    "--glass": themeVars.glass, "--glass-brd": themeVars.glassBrd, "--sheen": themeVars.sheen,
    "--acc": accentVars.acc, "--acc2": accentVars.acc2, "--cta-text": accentVars.ctaText, "--acc-text": accTextColor,
    "--acc-04": hexToRgba(accentVars.acc, .04), "--acc-06": hexToRgba(accentVars.acc, .06),
    "--acc-07": hexToRgba(accentVars.acc, .07), "--acc-08": hexToRgba(accentVars.acc, .08),
    "--acc-10": hexToRgba(accentVars.acc, .10), "--acc-22": hexToRgba(accentVars.acc, .22),
    "--acc-25": hexToRgba(accentVars.acc, .25), "--acc-30": hexToRgba(accentVars.acc, .30),
    "--acc-45": hexToRgba(accentVars.acc, .45),
  };
  const reviewDue = !dayOver && selIsToday && total > 0 && !!settings.reviewTime && nowMin >= toMin(settings.reviewTime);

  return (
    <div className="app" style={rootVars}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
        :root{
          --bg:#141416; --card:#1E1E21; --card2:#26262A; --line:#2C2C30;
          --text:#F5F5F5; --muted:#9B9B9E;
          --acc:#EC4E20; --acc2:#FFA552; --stroke:#B9D8C2; --ok:#BEE3CB; --danger:#E8A0A0; --lav:#D9CFF0;
        }
        *{box-sizing:border-box;margin:0;padding:0}
        .app{min-height:100vh;color:var(--text);background:var(--bg);
          font-family:'Inter',-apple-system,sans-serif;font-feature-settings:'cv11';
          display:flex;justify-content:center;padding:26px 14px 120px}
        .shell{width:100%;max-width:600px}
        .eyebrow{color:var(--muted);font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin-top:4px}
        h1{font-weight:800;font-size:clamp(22px,5.5vw,30px);letter-spacing:-0.02em}
        .clock{font-variant-numeric:tabular-nums;color:var(--acc-text);font-weight:700}
        .note{display:inline-block;margin-top:10px;font-size:13px;color:var(--acc-text);
          background:var(--acc-08);border:1px solid var(--acc-22);padding:5px 12px;border-radius:99px}

        .topbar{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:16px}
        .topbar-r{display:flex;gap:8px;flex:none}
        .icon-btn{width:40px;height:40px;flex:none;display:flex;align-items:center;justify-content:center;
          background:var(--card);border:1px solid var(--line);border-radius:50%;color:var(--text);cursor:pointer;transition:border-color .15s}
        .icon-btn:hover{border-color:var(--line2)}

        .weeknav{display:flex;align-items:center;gap:8px;margin-bottom:14px}
        .wn-arrow{width:38px;height:38px;flex:none;display:flex;align-items:center;justify-content:center;
          background:var(--card);border:1px solid var(--line);border-radius:50%;color:var(--text);cursor:pointer;transition:border-color .15s}
        .wn-arrow:hover{border-color:var(--line2)}
        .wn-label{position:relative;flex:1;display:flex;align-items:center;justify-content:center;
          background:var(--card);border:1px solid var(--line);border-radius:99px;color:var(--text);
          font-family:inherit;font-weight:600;font-size:13.5px;padding:9px 14px;cursor:pointer;transition:border-color .15s}
        .wn-label:hover{border-color:var(--line2)}
        .wn-label.has-today{padding-right:78px}
        .wn-mid{display:flex;align-items:center;gap:5px}
        .wn-mid svg{flex:none;color:var(--muted)}
        .wn-back{position:absolute;right:14px;top:50%;transform:translateY(-50%);
          font-size:11.5px;font-weight:700;color:var(--acc-text);background:var(--acc-10);
          border:1px solid var(--acc-30);border-radius:99px;padding:4px 11px;white-space:nowrap}

        /* Капсулы-дни в стиле референса */
        .week{display:flex;gap:6px;margin-bottom:16px}
        .day-cap{position:relative;flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:5px;
          background:var(--card);border:1px solid var(--line);border-radius:999px;
          padding:11px 2px;cursor:pointer;transition:border-color .15s,background .15s;color:var(--text);font-family:inherit}
        .day-cap:hover{border-color:var(--line2)}
        /* Прогресс-обводка по контуру: замыкается на 100% */
        .dc-ring{position:absolute;inset:0;width:100%;height:100%;
          color:var(--stroke);pointer-events:none;overflow:visible}
        .dc-ring rect{transition:stroke-dashoffset .5s cubic-bezier(.22,1,.36,1)}
        @media (prefers-reduced-motion:reduce){.dc-ring rect{transition:none}}
        .dc-ico{display:flex;align-items:center;justify-content:center;height:18px;color:var(--muted)}
        .dc-pct{font-size:10.5px;font-weight:700;color:var(--stroke);font-variant-numeric:tabular-nums;letter-spacing:-0.01em}
        .dc-dot{width:5px;height:5px;border-radius:50%;background:var(--muted);display:block}
        .dc-name{font-size:12.5px;font-weight:600;color:var(--muted)}
        .dc-num{font-size:16px;font-weight:800;letter-spacing:-0.02em}
        .day-cap.past{opacity:.5}
        .day-cap.past .dc-ico{color:var(--muted)}
        .day-cap .dc-ico svg{color:var(--muted)}
        .day-cap.today .dc-ico{color:var(--acc-text)}
        .day-cap.today .dc-name{color:var(--acc-text)}
        .day-cap.wknd .dc-name{color:var(--lav)}
        /* Выбранный день — залитая акцентом капсула, как в референсе */
        .day-cap.sel{background:var(--acc);border-color:var(--acc)}
        .day-cap.sel .dc-name,.day-cap.sel .dc-num,.day-cap.sel .dc-ico{color:var(--cta-text)}
        .day-cap.sel .dc-ico svg{color:var(--cta-text)}
        .day-cap.sel.wknd .dc-name{color:var(--cta-text)}
        .day-cap.sel .dc-dot{background:var(--cta-text)}
        .day-cap.sel .dc-pct{color:var(--cta-text)}
        .day-cap.sel .dc-ring{color:var(--cta-text)}

        .spin{display:inline-block;width:12px;height:12px;border:2px solid var(--muted);
          border-top-color:var(--acc);border-radius:50%;animation:sp .8s linear infinite}
        @keyframes sp{to{transform:rotate(360deg)}}
        .imp-err{width:100%;font-size:12.5px;color:var(--danger)}

        .card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:18px 20px}
        .progress-card{margin-bottom:18px}
        .ptop{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px}
        .pct{font-weight:800;font-size:30px;letter-spacing:-0.02em;font-variant-numeric:tabular-nums}
        .counts{color:var(--muted);font-size:13.5px}.counts b{color:var(--text)}
        .bar{height:12px;border-radius:99px;overflow:hidden;background:var(--track)}
        .fill{height:100%;border-radius:99px;background:linear-gradient(90deg,var(--acc),var(--acc2));
          transition:width .5s cubic-bezier(.22,1,.36,1)}
        @media (prefers-reduced-motion:reduce){.fill,.live-fill{transition:none}}
        .summary{margin-top:11px;font-size:13.5px;color:var(--muted)}.summary b{color:var(--text)}
        .weekline{margin-top:8px;font-size:12.5px;color:var(--muted)}

        /* Свёрнутый фильтр по ярлыкам */
        .filterbar{position:relative;margin-bottom:16px}
        .filter-toggle{display:inline-flex;align-items:center;gap:7px;background:var(--card);border:1px solid var(--line);
          color:var(--muted);font-family:inherit;font-size:12.5px;font-weight:600;padding:8px 14px;border-radius:99px;cursor:pointer;transition:border-color .15s}
        .filter-toggle.act{color:var(--acc-text);border-color:var(--acc)}
        .filter-pop{position:absolute;top:100%;left:0;margin-top:8px;z-index:10;
          background:var(--modal);border:1px solid var(--line);border-radius:14px;padding:8px;
          display:flex;flex-wrap:wrap;gap:6px;max-width:320px}

        .filters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:18px}
        .fchip{border:1px solid var(--line);background:var(--card);color:var(--muted);font-family:inherit;
          font-size:12.5px;font-weight:600;padding:6px 12px;border-radius:99px;cursor:pointer;
          transition:border-color .15s,color .15s;display:flex;align-items:center;gap:6px}
        .fchip .cdot{width:8px;height:8px;border-radius:50%}
        .fchip.on{color:var(--text);border-color:var(--acc2);background:var(--card2)}

        .banner{display:flex;align-items:center;gap:12px;justify-content:space-between;margin-bottom:20px;
          padding:13px 15px;border-radius:16px;background:var(--acc-07);
          border:1px solid var(--acc-25);font-size:14px}
        .cta{border:none;cursor:pointer;font-family:inherit;font-weight:700;font-size:14px;
          padding:10px 18px;border-radius:999px;white-space:nowrap;background:var(--acc);color:var(--cta-text);
          transition:filter .12s,transform .12s}
        .cta:hover{filter:brightness(1.06);transform:translateY(-1px)}
        .cta:disabled{opacity:.45;cursor:default}
        .ghost{display:inline-flex;align-items:center;justify-content:center;gap:6px;
          background:var(--card);border:1px solid var(--line);color:var(--muted);font-family:inherit;
          font-weight:600;font-size:13.5px;padding:8px 14px;border-radius:999px;cursor:pointer;transition:border-color .15s,color .15s}
        .ghost:hover{border-color:var(--line2);color:var(--text)}
        .ghost svg,.fchip svg,.mic svg{flex:none;display:block}
        /* Экспорт/Импорт, Повторы/Уведомления — делим ширину ряда поровну между кнопками */
        .danger-row .ghost{flex:1}


        .timeline{position:relative;padding-left:74px}
        .timeline::before{content:"";position:absolute;left:32px;top:0;bottom:10px;width:2px;
          background:var(--line);border-radius:2px}
        .row{position:relative;margin-bottom:10px}
        /* Время «от–до» в рамке прямо на линии дня */
        .t-frame{position:absolute;left:-74px;top:50%;transform:translateY(-50%);width:64px;z-index:1;
          display:flex;flex-direction:column;align-items:center;gap:2px;
          background:var(--card);border:1px solid var(--line);border-radius:12px;padding:6px 3px;
          font-family:inherit;font-size:11.5px;font-weight:600;color:var(--muted);
          font-variant-numeric:tabular-nums;cursor:pointer;transition:border-color .15s,color .15s}
        .t-frame:hover{border-color:var(--line2);color:var(--text)}
        .t-frame i{display:block;width:9px;height:1px;background:currentColor;opacity:.45}
        .t-frame.on{border-color:var(--acc);color:var(--acc-text)}
        @keyframes pulse{50%{opacity:.45}}
        @media (prefers-reduced-motion:reduce){.mic.rec{animation:none}}
        .task{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:11px 12px;
          transition:border-color .2s}
        .tbadges{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:7px}
        .tmain{flex:1;min-width:0;display:flex;align-items:center;gap:8px}

        /* Редактирование задачи */
        .edit-title{flex:1;min-width:0;background:var(--card2);border:1px solid var(--line);border-radius:10px;
          color:var(--text);font-family:inherit;font-size:15px;font-weight:500;padding:6px 9px}
        .edit-row{display:flex;align-items:center;gap:8px}
        .edit-row input[type=time]{background:var(--card2);border:1px solid var(--line);border-radius:10px;
          color:var(--text);font-family:inherit;font-size:13px;padding:6px 8px;color-scheme:var(--cs)}
        .task.active{border-color:var(--acc-45)}
        .task.past:not(.dc){opacity:.65}
        .trow{display:flex;align-items:flex-start;gap:10px}
        .check{flex:none;width:24px;height:24px;margin-top:1px;border-radius:8px;border:1.5px solid var(--line2);
          background:transparent;cursor:pointer;display:grid;place-items:center;color:#141416;
          font-size:14px;font-weight:800;transition:background .15s,border-color .15s}
        .check.on{background:var(--ok);border-color:var(--ok)}
        .check:focus-visible{outline:2px solid var(--acc);outline-offset:2px}

        /* Свой акцентный фокус вместо системной синей рамки браузера */
        input:focus,button:focus,select:focus{outline:none}
        input:focus-visible,button:focus-visible,select:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
        .t-title{min-width:0;font-size:15px;font-weight:500;cursor:text;line-height:1.35}
        .t-title.on{opacity:.4;text-decoration:line-through}
        .badge{flex:none;font-size:11px;font-weight:700;color:var(--acc-text);
          border:1px solid var(--acc-30);padding:2px 8px;border-radius:99px}
        .badge.late{color:var(--danger);border-color:rgba(232,160,160,.35)}
        .del{flex:none;margin-top:1px;background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;
          padding:4px 6px;opacity:.5;transition:opacity .15s,color .15s}
        .del:hover{opacity:1;color:var(--danger)}
        /* Свайп по карточке */
        .swipe-wrap{position:relative;overflow:hidden;border-radius:16px}
        .swipe-bg{position:absolute;inset:0;display:flex;align-items:center;justify-content:space-between;
          padding:0 16px;border-radius:16px;background:var(--card2);font-size:12.5px;font-weight:700}
        .sb-l{color:var(--ok)}
        .sb-r{color:var(--stroke)}
        .task{position:relative;touch-action:pan-y;user-select:none;-webkit-user-select:none}

        /* Заметка */
        .note{flex:none;max-width:15.5ch;display:inline-flex;align-items:center;justify-content:center;
          background:var(--card2);border:1px solid var(--line);border-radius:99px;
          padding:3px 10px;font-size:11.5px;color:var(--muted);line-height:1.4;cursor:text;
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center}
        .tmain{flex-wrap:wrap;row-gap:4px}
        .note-btn{flex:none;width:26px;height:26px;padding:0;display:flex;align-items:center;justify-content:center;
          background:none;border:none;border-radius:50%;color:var(--muted);cursor:pointer;opacity:.5;transition:opacity .15s}
        .note-btn:hover{opacity:1;color:var(--text)}
        .note-field{position:relative;display:block}
        .note-in{width:100%;background:var(--card2);border:1px solid var(--line);border-radius:10px;
          color:var(--text);font-family:inherit;font-size:13px;padding:7px 46px 7px 9px}
        .note-cnt{position:absolute;right:10px;top:50%;transform:translateY(-50%);
          font-size:10.5px;color:var(--muted);font-variant-numeric:tabular-nums;pointer-events:none}
        .note-cnt.full{color:var(--danger)}

        /* Свободный промежуток между делами */
        .gap{display:block;width:100%;margin:0 0 10px;padding:7px 0;background:none;border:none;
          border-left:1px dashed var(--line);border-radius:0;
          color:var(--muted);font-family:inherit;font-size:11.5px;text-align:left;padding-left:14px;cursor:pointer;opacity:.75}
        .gap:hover{opacity:1}
        .gap span{color:var(--stroke);font-weight:600}

        /* Антипрокрастинация */
        .nudge{display:flex;flex-direction:column;gap:4px;margin-bottom:16px;padding:12px 15px;
          border-radius:16px;background:rgba(232,160,160,.06);border:1px solid rgba(232,160,160,.28);font-size:13px}
        .nudge b{color:var(--danger);font-size:13.5px}
        .nudge span{color:var(--muted);line-height:1.45}
        .badge.stuck{color:var(--danger);border-color:rgba(232,160,160,.45);background:rgba(232,160,160,.10)}
        .s-proc{display:flex;gap:8px;margin-bottom:10px}
        .s-tile{flex:1;background:var(--card2);border:1px solid var(--line);border-radius:14px;
          padding:12px 8px;text-align:center}
        .s-tile b{display:block;font-size:20px;font-weight:800;letter-spacing:-0.02em;font-variant-numeric:tabular-nums}
        .s-tile span{font-size:11px;color:var(--muted)}
        .s-tile.warn{border-color:rgba(232,160,160,.4)}
        .s-tile.warn b{color:var(--danger)}

        .ext-btn{margin-top:8px;background:none;border:1px solid var(--line);border-radius:99px;
          color:var(--muted);font-family:inherit;font-size:11.5px;font-weight:600;padding:5px 12px;cursor:pointer;
          transition:border-color .15s,color .15s}
        .ext-btn:hover{border-color:var(--acc);color:var(--acc-text)}
        .ext-none{margin-top:8px;font-size:11.5px;color:var(--danger);opacity:.9}
        .ask-modal{max-width:400px;text-align:center}
        .ask-modal h2{margin-bottom:6px}
        .ask-modal .sub{margin-bottom:18px}
        .ask-modal .sub b{color:var(--text)}
        .ask-acts{display:flex;flex-direction:column;gap:8px}
        .ask-acts .cta,.ask-acts .ghost{width:100%;justify-content:center}
        .ask-note{margin-top:14px;font-size:11.5px;color:var(--muted);line-height:1.4}

        .live{margin-top:9px}
        .live-info{display:flex;justify-content:space-between;font-size:12.5px;color:var(--muted);margin-bottom:6px}
        .live-info b{color:var(--acc)}
        .live-bar{height:5px;border-radius:99px;background:var(--track);overflow:hidden}
        .live-fill{height:100%;border-radius:99px;background:linear-gradient(90deg,var(--acc),var(--acc2));transition:width 1s linear}

        .empty{text-align:center;color:var(--muted);padding:26px 18px;border:1px dashed var(--line);
          border-radius:20px;font-size:13.5px}
        .empty b{color:var(--text);display:block;margin-bottom:6px;font-size:16px}

        .add{width:100%;margin-top:24px;
          display:flex;gap:8px;flex-wrap:wrap;border-radius:20px;padding:10px}
        .add .catrow{width:100%;display:flex;gap:5px;flex-wrap:wrap;padding:0 4px}
        .add input[type=text]{flex:1 1 150px;min-width:0;background:transparent;
          border:1px solid transparent;border-radius:10px;color:var(--text);
          font-family:inherit;font-size:15px;padding:8px 10px;transition:border-color .15s}
        .add input[type=text]:focus{outline:none;border-color:var(--acc)}
        .add input[type=text]::placeholder{color:var(--muted)}
        .add input[type=time]{flex:none;background:var(--card2);border:1px solid var(--line);
          border-radius:12px;color:var(--text);font-family:inherit;font-size:13.5px;padding:8px 8px;color-scheme:var(--cs)}
        .add .sep{align-self:center;color:var(--muted);font-size:13px}
        .mic{flex:none;width:42px;display:flex;align-items:center;justify-content:center;border:1px solid var(--line);
          border-radius:999px;background:var(--card2);color:var(--text);cursor:pointer;transition:border-color .15s}
        .mic:hover{border-color:var(--line2)}
        .mic.rec{background:rgba(232,160,160,.15);border-color:var(--danger);color:var(--danger);animation:pulse 1.5s infinite}
        .voice-err{width:100%;font-size:12px;color:var(--danger);padding:0 10px 2px}

        .overlay{position:fixed;inset:0;background:rgba(10,10,12,.88);
          display:flex;align-items:center;justify-content:center;padding:16px;z-index:50}
        .modal{width:100%;max-width:520px;max-height:86vh;overflow:auto;background:var(--modal);
          border:1px solid var(--line);border-radius:22px;padding:24px}
        .modal h2{font-size:19px;font-weight:800;letter-spacing:-0.01em;margin-bottom:4px}
        .modal .sub{color:var(--muted);font-size:13.5px;margin-bottom:16px}
        .rv-sum{margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--line)}
        .rv-tiles{display:flex;gap:8px;margin-bottom:12px}
        .rv-tile{flex:1;background:var(--card2);border:1px solid var(--line);border-radius:12px;padding:10px 6px;text-align:center}
        .rv-tile b{display:block;font-size:19px;font-weight:800;font-variant-numeric:tabular-nums}
        .rv-tile span{font-size:10.5px;color:var(--muted)}
        .rv-tile.warn{border-color:rgba(232,160,160,.4)}
        .rv-tile.warn b{color:var(--danger)}
        .rv-mtx{display:flex;flex-direction:column;gap:6px}
        .rv-line{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--muted)}
        .rv-line .cdot{width:8px;height:8px;border-radius:50%;flex:none}
        .rv-lbl{flex:1}
        .rv-line b{color:var(--text);font-variant-numeric:tabular-nums}

        .r-item{padding:12px 0;border-top:1px solid var(--line)}
        .r-title{font-size:15px;font-weight:600;margin-bottom:3px}
        .r-time{font-size:12.5px;color:var(--muted);margin-bottom:9px;font-variant-numeric:tabular-nums}
        .seg{display:flex;gap:6px;flex-wrap:wrap}
        .seg button{flex:1;min-width:96px;border:1px solid var(--line);background:transparent;color:var(--muted);
          font-family:inherit;font-size:13px;font-weight:600;padding:8px 10px;border-radius:10px;cursor:pointer;
          transition:border-color .15s,color .15s,background .15s}
        .seg .sd{background:rgba(190,227,203,.12);border-color:var(--ok);color:var(--ok)}
        .seg .st{background:var(--acc-10);border-color:var(--acc);color:var(--acc-text)}
        .seg .sx{background:rgba(232,160,160,.10);border-color:var(--danger);color:var(--danger)}
        .modal-actions{display:flex;gap:10px;margin-top:18px;justify-content:flex-end}

        .imp-row{display:flex;align-items:flex-start;gap:10px;padding:11px 0;border-top:1px solid var(--line)}
        .imp-row input{margin-top:4px;accent-color:var(--acc);width:16px;height:16px}
        .imp-row .it{flex:1}
        .imp-row .itt{font-size:14.5px;font-weight:600}
        .imp-row .its{font-size:12.5px;color:var(--muted);margin-top:2px}

        .closed-card{text-align:center;padding:36px 22px;margin-bottom:22px}
        .closed-card .big{font-size:24px;font-weight:800;letter-spacing:-0.02em;margin:4px 0 6px}
        .closed-card p{color:var(--muted);font-size:14px;margin-bottom:16px}
        .linkish{background:none;border:none;color:var(--muted);text-decoration:underline;cursor:pointer;
          font-family:inherit;font-size:13px;margin-top:12px}

        /* Сетка недели */
        /* Нижний тулбар, как в приложениях iOS */
        /* --- Стекло: приближение Liquid Glass. Только на двух поверхностях,
           чтобы не грузить GPU: они не перерисовываются каждую секунду. --- */
        .glass{position:relative;
          background:var(--glass);
          -webkit-backdrop-filter:blur(24px) saturate(180%);
          backdrop-filter:blur(24px) saturate(180%);
          border:1px solid var(--glass-brd)}
        @supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){
          .glass{background:var(--overlay)}
        }
        @media (prefers-reduced-transparency:reduce){
          .glass{background:var(--overlay);backdrop-filter:none;-webkit-backdrop-filter:none}
        }

        /* Плавающая капсула-тулбар */
        .tabbar{position:fixed;left:50%;transform:translateX(-50%);
          bottom:calc(14px + env(safe-area-inset-bottom, 0px));
          z-index:45;display:flex;align-items:center;gap:4px;
          padding:7px;border-radius:999px;width:auto;max-width:calc(100% - 28px)}
        .tabbar button{flex:none;width:52px;height:52px;padding:0;
          display:flex;align-items:center;justify-content:center;
          background:none;border:none;border-radius:50%;cursor:pointer;color:var(--muted);
          transition:color .2s,background .2s,transform .14s cubic-bezier(.22,1,.36,1)}
        .tabbar button.on{background:var(--acc);color:var(--cta-text)}
        .tabbar button:active{transform:scale(.9)}
        @media (prefers-reduced-motion:reduce){.tabbar button:active{transform:none}}
        .tabbar svg{width:22px;height:22px}
        .viewtoggle{display:flex;gap:6px;margin-bottom:14px}
        .viewtoggle .fchip.on{color:var(--acc-text);border-color:var(--acc)}
        .daycard{padding:14px 14px 10px;margin-bottom:18px}

        .dg-head{display:flex;align-items:center;gap:8px;margin-bottom:14px}
        .dg-title{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:1px;
          background:var(--card2);border:1px solid var(--line);border-radius:99px;padding:8px 12px;
          font-family:inherit;cursor:pointer;transition:border-color .15s}
        .dg-title:hover{border-color:var(--line2)}
        .dg-title b{font-size:14px;font-weight:700;color:var(--text);text-transform:capitalize}
        .dg-title b.on{color:var(--acc-text)}
        .dg-title span{font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums}

        .dg-body{display:flex;gap:0}
        .dg-hours{position:relative;width:46px;flex:none}
        .dg-hour{position:absolute;right:8px;transform:translateY(-6px);font-size:11px;
          color:var(--muted);font-variant-numeric:tabular-nums}
        .dg-col{position:relative;flex:1;min-width:0;border-left:1px solid var(--line)}
        .dg-line{position:absolute;left:0;right:0;height:1px;background:var(--line);opacity:.5}
        .dg-empty{position:absolute;top:44%;left:0;right:0;text-align:center;
          font-size:13px;color:var(--muted)}

        /* Блок дела: колонка одна — влезает название, время и заметка */
        .dg-block{position:absolute;left:6px;right:2px;border-radius:10px;padding:6px 10px;overflow:hidden;
          touch-action:none;user-select:none;-webkit-user-select:none;cursor:grab}
        .dg-block b{display:block;font-size:13.5px;font-weight:700;color:var(--text);line-height:1.25}
        .dg-block i{display:block;margin-top:2px;font-style:normal;font-size:11px;color:var(--muted);
          font-variant-numeric:tabular-nums}
        .dg-block em{display:block;margin-top:3px;font-style:normal;font-size:11px;color:var(--muted);
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.85}
        .dg-block.b-done{opacity:.42}
        .dg-block.b-done b{text-decoration:line-through}
        .dg-block.dragging{cursor:grabbing;z-index:5;outline:2px solid var(--acc);outline-offset:1px}

        .dg-now{position:absolute;left:0;right:0;height:2px;background:var(--danger);z-index:2;pointer-events:none}
        .dg-now::before{content:"";position:absolute;left:-3px;top:-3px;width:8px;height:8px;
          border-radius:50%;background:var(--danger)}

        .grid-hint{margin-top:8px;font-size:11.5px;color:var(--muted);text-align:center}

        /* Статистика */
        .s-h{font-size:18px;font-weight:800;letter-spacing:-0.01em;margin-bottom:4px}
        .s-sub{font-size:12.5px;color:var(--muted);margin-bottom:16px}
        .s-week{display:flex;gap:8px;align-items:flex-end;margin-bottom:20px}
        .s-day{flex:1;text-align:center}
        .s-bar{height:90px;background:var(--track);border-radius:8px;display:flex;align-items:flex-end;overflow:hidden}
        .s-bar i{display:block;width:100%;background:linear-gradient(180deg,var(--acc2),var(--acc));border-radius:8px 8px 0 0;transition:height .5s cubic-bezier(.22,1,.36,1)}
        .s-day span{display:block;font-size:11.5px;color:var(--muted);margin-top:5px;font-weight:700}
        .s-day span.s-today{color:var(--acc)}
        .s-day em{font-style:normal;font-size:10.5px;color:var(--muted)}
        .s-cat{display:flex;align-items:center;gap:10px;margin-bottom:8px;font-size:13px}
        .s-cat span{width:100px;flex:none;color:var(--muted);font-weight:600}
        .s-cbar{flex:1;height:10px;border-radius:99px;background:var(--track);overflow:hidden}
        .s-cbar i{display:block;height:100%;border-radius:99px;transition:width .5s cubic-bezier(.22,1,.36,1)}
        .s-cat em{font-style:normal;width:48px;flex:none;text-align:right;color:var(--text);font-size:12px;font-variant-numeric:tabular-nums}

        /* Повторы */
        .r-line{display:flex;align-items:center;gap:8px;padding:10px 0;border-top:1px solid var(--line);font-size:14px}
        .r-line .meta{color:var(--muted);font-size:12px;margin-top:2px;font-variant-numeric:tabular-nums}
        .r-days{display:flex;gap:5px;flex-wrap:wrap;width:100%}
        .r-form{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}
        .r-form input[type=text]{flex:1 1 140px;min-width:0;background:var(--card2);border:1px solid var(--line);
          border-radius:12px;color:var(--text);font-family:inherit;font-size:14px;padding:8px 10px}
        .r-form input[type=text]::placeholder{color:var(--muted)}
        .r-form input[type=time]{background:var(--card2);border:1px solid var(--line);border-radius:12px;
          color:var(--text);font-family:inherit;font-size:13px;padding:8px;color-scheme:var(--cs)}

        /* Настройки */
        .set-sec{margin-top:18px;padding-top:16px;border-top:1px solid var(--line)}
        .set-sec:first-of-type{margin-top:0;padding-top:0;border-top:none}
        .set-h{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px}
        .set-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;font-size:14px;flex-wrap:wrap}
        .set-row .lbl{color:var(--text)}
        .set-row .lbl small{display:block;color:var(--muted);font-size:11.5px;font-weight:400;margin-top:1px}
        .seg2{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
        .seg2 button{border:1px solid var(--line);background:var(--card2);color:var(--muted);font-family:inherit;
          font-size:12.5px;font-weight:600;padding:7px 12px;border-radius:10px;cursor:pointer;transition:border-color .15s,color .15s}
        .seg2 button.on{color:var(--text);border-color:var(--acc2)}
        .seg2 input[type=time]{background:var(--card2);border:1px solid var(--line);border-radius:10px;
          color:var(--text);font-family:inherit;font-size:13px;padding:6px 8px;color-scheme:var(--cs)}
        .sep{color:var(--muted);font-size:13px}
        .swatch{width:26px;height:26px;border-radius:50%;border:2px solid var(--line);cursor:pointer;padding:0;transition:border-color .15s}
        .swatch.on{border-color:var(--text)}
        select.set-sel{background:var(--card2);border:1px solid var(--line);border-radius:10px;color:var(--text);
          font-family:inherit;font-size:13.5px;padding:7px 10px;color-scheme:var(--cs)}
        .time-clear{background:none;border:none;color:var(--muted);font-size:12px;text-decoration:underline;cursor:pointer;padding:0}
        .danger-row{display:flex;gap:8px;flex-wrap:wrap}
        .danger-btn{border:1px solid var(--line);background:var(--card2);color:var(--danger);font-family:inherit;
          font-weight:600;font-size:13px;padding:8px 14px;border-radius:999px;cursor:pointer;transition:border-color .15s}
        .danger-btn:hover{border-color:var(--danger)}
        .set-msg{font-size:12.5px;color:var(--acc-text);margin-top:10px}
        .set-ver{font-size:12px;color:var(--muted);margin-top:4px}
        .file-hidden{position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none}

        /* Тост (предупреждения о пересечении, отмена удаления, сводка распределения) */
        .toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:60;
          display:flex;align-items:center;gap:10px;max-width:88vw;
          background:var(--modal);border:1px solid var(--line);border-radius:14px;
          padding:11px 14px;font-size:13.5px;color:var(--text)}
        .toast button{flex:none;background:none;border:none;color:var(--acc-text);font-weight:700;
          font-family:inherit;font-size:13.5px;cursor:pointer;padding:0}

        /* Попап выбора ярлыка на карточке дела */
        .edit-box{margin-top:10px;padding-top:10px;border-top:1px solid var(--line);
          display:flex;flex-direction:column;gap:8px}
        .edit-days{display:flex;gap:4px}
        .day-chip{flex:1;min-width:0;background:var(--card2);border:1px solid var(--line);
          border-radius:99px;color:var(--muted);font-family:inherit;font-size:12px;font-weight:700;
          padding:7px 2px;cursor:pointer;text-align:center;transition:background .15s,color .15s,border-color .15s}
        .day-chip.on{background:var(--acc);color:var(--cta-text);border-color:var(--acc)}
        .edit-cats{display:flex;gap:5px;flex-wrap:wrap}
        .edit-actions{display:flex;gap:8px;justify-content:flex-end}
        .edit-actions .cta{padding:7px 16px;font-size:13px}
        .edit-actions .ghost{padding:7px 14px;font-size:13px}
        .set-note{font-size:12px;color:var(--muted);margin-top:-4px;margin-bottom:10px}

        /* Календарь-пикер */
        .cal-modal{max-width:352px;padding:20px}
        .cal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
        .cal-head h2{font-size:17px;font-weight:800;margin:0}
        .cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:0}
        .cal-dow{margin-bottom:2px}
        .cal-dowc{text-align:center;font-size:11px;font-weight:700;color:var(--muted);padding:4px 0}
        .cal-cell{min-width:0;height:42px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
          background:transparent;border:none;padding:0;color:var(--text);
          font-family:inherit;font-size:14.5px;font-weight:600;cursor:pointer}
        .cal-cell.empty{visibility:hidden;pointer-events:none}
        /* Полоса текущей недели — сплошная, скруглена только по краям */
        .cal-cell.inweek{background:var(--acc-08)}
        .cal-cell.inweek.wk-l{border-radius:12px 0 0 12px}
        .cal-cell.inweek.wk-r{border-radius:0 12px 12px 0}
        .cal-num{width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:50%;
          font-variant-numeric:tabular-nums}
        .cal-cell:hover .cal-num{background:var(--card2)}
        .cal-num.today{background:var(--acc);color:var(--cta-text);font-weight:800}
        .cal-cell:hover .cal-num.today{background:var(--acc)}
        .cal-dot{width:4px;height:4px;border-radius:50%;background:var(--acc);flex:none}
        .cal-dot.blank{background:transparent}

        @media (max-width:500px){
          .timeline{padding-left:64px}
          .timeline::before{left:27px}
          .t-frame{left:-64px;width:54px;font-size:11px;padding:5px 2px}
          .day-cap{padding:10px 1px}
          .dc-name{font-size:11.5px}
          .dc-num{font-size:15px}
          .set-row{gap:8px}
        }
      `}</style>

      <div className="shell">
        <header className="topbar">
          <div className="topbar-l">
            <h1>Моя неделя</h1>
            <div className="eyebrow">
              {DAY_FULL[sel]} · {selDate.getDate()} {MONTHS[selDate.getMonth()]}
              {selIsToday && (<> · <span className="clock">
                {settings.timeFormat === 12
                  ? `${(now.getHours() % 12) || 12}:${pad(now.getMinutes())} ${now.getHours() < 12 ? "AM" : "PM"}`
                  : `${pad(now.getHours())}:${pad(now.getMinutes())}`}
              </span></>)}
            </div>
          </div>
        </header>

        <div className="weeknav">
          <button className="wn-arrow" onClick={() => switchWeek(mondayKeyOffset(viewMondayKey, -1))} aria-label="Прошлая неделя"><I.chevL /></button>
          <button className={`wn-label ${!isCurrentWeek ? "has-today" : ""}`} onClick={() => setShowCalendar(true)}>
            <span className="wn-mid">
              <I.cal />
              <span>{monday.getDate()} {MONTHS[monday.getMonth()]} — {dayDate(6).getDate()} {MONTHS[dayDate(6).getMonth()]}</span>
            </span>
            {!isCurrentWeek && <span className="wn-back" onClick={(e) => { e.stopPropagation(); goToday(); }}>Сегодня</span>}
          </button>
          <button className="wn-arrow" onClick={() => switchWeek(mondayKeyOffset(viewMondayKey, 1))} aria-label="Следующая неделя"><I.chevR /></button>
        </div>

        {view === "day" && (<div className="week" role="tablist" aria-label="Дни недели" ref={weekRef}>
          {DAY_NAMES.map((n, i) => {
            const d = dayDate(i);
            const dk = dateKey(d);
            const isToday = dk === todayKey;
            const isPast = dk < todayKey;
            const dayList = days[i] || [];
            const dDone = dayList.filter((t) => t.done).length;
            const dPct = dayList.length ? Math.round((dDone / dayList.length) * 100) : 0;
            const full = dayList.length > 0 && dPct === 100;
            return (
              <button key={i} role="tab" aria-selected={sel === i}
                className={`day-cap ${sel === i ? "sel" : ""} ${isToday ? "today" : ""} ${isPast && !full ? "past" : ""} ${i >= 5 ? "wknd" : ""}`}
                onClick={() => setSel(i)}
                aria-label={`${DAY_FULL[i]} ${d.getDate()}, выполнено ${dPct}%`}>
                {dayList.length > 0 && (
                  <svg className="dc-ring" viewBox={`0 0 ${capSize.w} ${capSize.h}`} aria-hidden="true">
                    <rect x={RING_W / 2} y={RING_W / 2}
                      width={Math.max(0, capSize.w - RING_W)} height={Math.max(0, capSize.h - RING_W)}
                      rx={Math.max(0, capSize.w - RING_W) / 2} ry={Math.max(0, capSize.w - RING_W) / 2}
                      fill="none" stroke="currentColor" strokeWidth={RING_W} strokeLinecap="round"
                      pathLength="100" strokeDasharray="100" strokeDashoffset={100 - dPct} />
                  </svg>
                )}
                <span className="dc-ico">
                  {dayList.length === 0
                    ? (isPast ? <span className="dc-dot" /> : <I.spark />)
                    : <span className="dc-pct">{dPct}%</span>}
                </span>
                <span className="dc-name">{n}</span>
                <span className="dc-num">{d.getDate()}</span>
              </button>
            );
          })}
        </div>)}


        {view === "grid" ? (
          <DayGrid days={days} todayIdx={isCurrentWeek ? todayIdx : -1} sel={sel} nowMin={nowMin} dayDate={dayDate}
            timeFormat={settings.timeFormat} onMove={moveTask}
            onOpenCal={() => setShowCalendar(true)}
            onPrev={() => {
              if (sel > 0) setSel(sel - 1);
              else { switchWeek(mondayKeyOffset(viewMondayKey, -1)); setSel(LAST); }   // ушли за понедельник — прошлая неделя
            }}
            onNext={() => {
              if (sel < LAST) setSel(sel + 1);
              else { switchWeek(mondayKeyOffset(viewMondayKey, 1)); setSel(0); }       // ушли за воскресенье — следующая неделя
            }} />
        ) : view === "stats" ? (
          <section className="card" style={{ marginBottom: 18 }}>
            <div className="s-h">{streak > 0 ? `Серия: ${streak} ${plural(streak, "день", "дня", "дней")} подряд` : "Серия пока не начата"}</div>
            <div className="s-sub">День засчитывается, когда ты закрываешь его через «Итоги дня». Не прерывай цепочку!</div>
            <div className="s-week">
              {DAY_NAMES.map((n, i) => {
                const l = days[i] || [];
                const dn = l.filter((t) => t.done).length;
                const p = l.length ? (dn / l.length) * 100 : 0;
                return (
                  <div key={i} className="s-day">
                    <div className="s-bar"><i style={{ height: `${p}%` }} /></div>
                    <span className={dateKey(dayDate(i)) === todayKey ? "s-today" : ""}>{n}</span>
                    <em>{dn}/{l.length}</em>
                  </div>
                );
              })}
            </div>
            <div className="s-sub" style={{ marginBottom: 10 }}>Дисциплина</div>
            {(() => {
              const moves = weekAll.reduce((a, t) => a + (t.moves || 0), 0);
              const stuckW = weekAll.filter((t) => (t.moves || 0) >= STUCK && !t.done).length;
              const doneW = weekAll.filter((t) => t.done).length;
              const eff = weekAll.length ? Math.round((doneW / weekAll.length) * 100) : 0;
              return (
                <>
                  <div className="s-proc">
                    <div className="s-tile"><b>{eff}%</b><span>эффективность</span></div>
                    <div className={`s-tile ${moves > weekAll.length ? "warn" : ""}`}><b>{moves}</b><span>переносов</span></div>
                    <div className={`s-tile ${stuckW > 0 ? "warn" : ""}`}><b>{stuckW}</b><span>застряло</span></div>
                  </div>
                  <div className="s-sub">
                    {stuckW > 0
                      ? `${stuckW} ${plural(stuckW, "дело переносится", "дела переносятся", "дел переносятся")} ${STUCK}+ раз. Это не занятость — это избегание. Сделай их первыми завтра.`
                      : moves > weekAll.length && weekAll.length > 0
                        ? "Переносов больше, чем дел. План слишком плотный — сократи его, а не себя."
                        : "Ничего не застряло. Так держать."}
                  </div>
                </>
              );
            })()}

            <div className="s-sub" style={{ marginBottom: 10, marginTop: 18 }}>Время по важности за неделю</div>
            {CAT_ORDER.map((k) => catMins[k] > 0 && (
              <div className="s-cat" key={k}>
                <span>{CATS[k].label}</span>
                <div className="s-cbar"><i style={{ width: `${(catMins[k] / maxCat) * 100}%`, background: CATS[k].color }} /></div>
                <em>{Math.round((catMins[k] / 60) * 10) / 10} ч</em>
              </div>
            ))}
            {weekAll.length === 0 && <div className="s-sub">Добавь дела — тут появится аналитика недели.</div>}
          </section>
        ) : isClosed ? (
          <div className="card closed-card">
            <div className="big">День закрыт</div>
            <p>Выполнено {doneN} из {total}. Перенесённое уже ждёт {sel < LAST ? "в следующем дне" : "в понедельнике"}.</p>
            <div className="bar"><div className="fill" style={{ width: `${pct}%` }} /></div>
            <button className="linkish" onClick={reopenDay}>Вернуться к дню</button>
          </div>
        ) : (
          <>
            <section className="card progress-card" aria-label="Прогресс дня">
              <div className="ptop">
                <span className="pct">{pct}%</span>
                <span className="counts"><b>{doneN}</b> из <b>{total}</b> · осталось <b>{total - doneN}</b></span>
              </div>
              <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="summary">
                {activeTask && (<>Сейчас: <b>{activeTask.title}</b> — до {fmtTime(activeTask.to, settings.timeFormat)}.</>)}
                {!activeTask && nextTask && (<>Пауза. Далее: <b>{nextTask.title}</b> в {fmtTime(nextTask.from, settings.timeFormat)}.</>)}
                {!selIsToday && total > 0 && (dateKey(dayDate(sel)) < todayKey ? "Этот день уже прошёл." : "План на этот день.")}
                {total === 0 && "Пока пусто. Добавь дело внизу или подтяни события из календаря."}
              </div>
              {weekAll.length > 0 && (
                <div className="weekline">
                  Неделя: {weekAll.filter((t) => t.done).length} из {weekAll.length} {plural(weekAll.length, "дела", "дел", "дел")} выполнено
                </div>
              )}
            </section>

            {total > 0 && (
              <div className="filterbar">
                <button className={`filter-toggle ${filter !== "all" ? "act" : ""}`} onClick={() => setShowFilters((v) => !v)}>
                  <I.filter /> {filter === "all" ? "Важность" : CATS[filter].label}
                </button>
                {showFilters && (
                  <div className="filter-pop">
                    <button className={`fchip ${filter === "all" ? "on" : ""}`} onClick={() => { setFilter("all"); setShowFilters(false); }}>Все</button>
                    {CAT_ORDER.map((k) => (
                      <button key={k} className={`fchip ${filter === k ? "on" : ""}`}
                        style={filter === k ? { borderColor: CATS[k].color, color: CATS[k].color } : undefined}
                        onClick={() => { setFilter(filter === k ? "all" : k); setShowFilters(false); }}>
                        <span className="cdot" style={{ background: CATS[k].color }} />{CATS[k].label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {(dayOver || reviewDue) && !isClosed && (
              <div className="banner">
                <span>{dayOver ? "Расписание на сегодня закончилось. Подведём итоги?" : `Время (${fmtTime(settings.reviewTime, settings.timeFormat)}) подвести итоги дня.`}</span>
                <button className="cta" onClick={openReview}>Итоги дня</button>
              </div>
            )}

            {loaded && shown.length === 0 && (
              <div className="empty">
                <b>{total === 0 ? "Чистый лист" : "Ничего с таким ярлыком"}</b>
                {total === 0 ? "Скажи голосом «с 10 до 11 тренировка» — и дело встанет в расписание." : "Сбрось фильтр, чтобы увидеть весь день."}
              </div>
            )}

            {stuckToday.length > 0 && (
              <div className="nudge">
                <b>Застряло: {stuckToday.length} {plural(stuckToday.length, "дело", "дела", "дел")}</b>
                <span>{stuckToday.map((t) => t.title).join(", ")} — переносишь {STUCK}+ раз. Начни с этого, разбей на шаги или удали совсем.</span>
              </div>
            )}

            <div className="timeline">
              {shown.map((t, ti) => {
                const st = status(t, sel);
                const s = toMin(t.from), e = toMin(t.to);
                const livePct = st === "active" ? Math.min(100, ((nowMin - s) / (e - s)) * 100) : 0;
                const cinfo = cat_(t.cat);
                const sw = swipe && swipe.id === t.id ? swipe.dx : 0;
                // Свободный промежуток до следующего дела
                const nxt = shown[ti + 1];
                const gap = nxt ? toMin(nxt.from) - e : 0;
                return (
                  <div key={t.id}>
                    <div className="row">
                      <button className={`t-frame ${st === "active" ? "on" : ""}`} onClick={() => openEdit(t)} aria-label="Изменить время">
                        <span>{fmtTime(t.from, settings.timeFormat)}</span>
                        <i />
                        <span>{fmtTime(t.to, settings.timeFormat)}</span>
                      </button>
                      <div className="swipe-wrap">
                        <div className="swipe-bg">
                          <span className="sb-l">{t.done ? "Снять" : "Готово"}</span>
                          <span className="sb-r">Перенести</span>
                        </div>
                        <div className={`task ${st} ${t.done ? "dc" : ""}`}
                          style={{ transform: sw ? `translateX(${sw}px)` : undefined,
                                   transition: sw ? "none" : "transform .2s ease, border-color .2s" }}
                          onPointerDown={(ev) => startSwipe(ev, t)}>

                          {(t.routineId || t.carried || (st === "past" && !t.done)) && (
                            <div className="tbadges">
                              {t.routineId && <span className="badge">повтор</span>}
                              {(t.moves || 0) >= STUCK
                                ? <span className="badge stuck">переносов ×{t.moves}</span>
                                : t.carried && <span className="badge">перенос{(t.moves || 0) > 1 ? ` ×${t.moves}` : ""}</span>}
                              {st === "past" && !t.done && <span className="badge late">не закрыто</span>}
                            </div>
                          )}

                          <div className="trow">
                            <button className={`check ${t.done ? "on" : ""}`}
                              style={!t.done ? { borderColor: cinfo.color } : undefined}
                              onClick={() => toggle(t.id)}
                              aria-label={t.done ? "Снять отметку" : "Отметить выполненным"}>{t.done ? "✓" : ""}</button>

                            <div className="tmain">
                              {editFor === t.id ? (
                                <input className="edit-title" autoFocus={!noteFocus} value={eTitle}
                                  onChange={(ev) => setETitle(ev.target.value)}
                                  onKeyDown={(ev) => { if (ev.key === "Enter") saveEdit(); if (ev.key === "Escape") setEditFor(null); }} />
                              ) : (
                                <span className={`t-title ${t.done ? "on" : ""}`} onClick={() => openEdit(t)}>{t.title}</span>
                              )}
                              {t.note && editFor !== t.id && (
                                <div className="note" onClick={() => openEdit(t)}>{t.note}</div>
                              )}
                            </div>

                            {editFor !== t.id && (
                              <button className="note-btn" onClick={() => openEdit(t, true)}
                                aria-label={t.note ? "Изменить заметку" : "Добавить заметку"}><I.note /></button>
                            )}
                            <button className="del" onClick={() => remove(t.id)} aria-label="Удалить">×</button>
                          </div>

                          {editFor === t.id && (
                            <div className="edit-box">
                              <div className="edit-days">
                                {DAY_NAMES.map((n, i) => (
                                  <button key={i} className={`day-chip ${eDay === i ? "on" : ""}`} onClick={() => setEDay(i)}>{n}</button>
                                ))}
                              </div>
                              <div className="edit-row">
                                <input type="time" value={eFrom} onChange={(ev) => setEFrom(ev.target.value)} aria-label="Начало" />
                                <span className="sep">—</span>
                                <input type="time" value={eTo} onChange={(ev) => setETo(ev.target.value)} aria-label="Конец" />
                              </div>
                              <label className="note-field">
                                <input className="note-in" value={eNote} placeholder="Заметка…" autoFocus={noteFocus}
                                  onChange={(ev) => { const v = ev.target.value; if (noteLen(v) <= NOTE_MAX) setENote(v); }}
                                  onKeyDown={(ev) => { if (ev.key === "Enter") saveEdit(); if (ev.key === "Escape") setEditFor(null); }} />
                                <span className={`note-cnt ${noteLen(eNote) >= NOTE_MAX ? "full" : ""}`}>{noteLen(eNote)}/{NOTE_MAX}</span>
                              </label>
                              <div className="edit-cats">
                                {CAT_ORDER.map((k) => (
                                  <button key={k} className={`fchip ${eCat === k ? "on" : ""}`}
                                    style={eCat === k ? { borderColor: CATS[k].color, color: CATS[k].color } : undefined}
                                    onClick={() => setECat(k)}>
                                    <span className="cdot" style={{ background: CATS[k].color }} />{CATS[k].label}
                                  </button>
                                ))}
                              </div>
                              <div className="edit-actions">
                                <button className="ghost" onClick={() => setEditFor(null)}>Отмена</button>
                                <button className="cta" onClick={saveEdit}>Сохранить</button>
                              </div>
                            </div>
                          )}

                          {st === "active" && !t.done && (
                            <div className="live">
                              <div className="live-info">
                                <span>идёт сейчас</span>
                                <span>осталось <b>{fmtLeft(e - nowMin)}</b></span>
                              </div>
                              <div className="live-bar"><div className="live-fill" style={{ width: `${livePct}%` }} /></div>
                              {(t.ext || 0) < MAX_EXT ? (
                                <button className="ext-btn" onClick={() => extendTask(t, sel)}>
                                  +{EXT_MIN} мин · осталось {MAX_EXT - (t.ext || 0)}
                                </button>
                              ) : (
                                <div className="ext-none">Продления кончились — только «сделано» или перенос</div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    {gap >= 30 && (
                      <button className="gap" onClick={() => quickAdd(toHHMM(e), toHHMM(Math.min(e + settings.defaultDuration, toMin(nxt.from))))}>
                        {fmtLeft(gap)} свободно · <span>добавить</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {total > 0 && !dayOver && (
              <div style={{ textAlign: "center", marginTop: 16 }}>
                <button className="ghost" onClick={openReview}>Подвести итоги дня</button>
              </div>
            )}

            <div className="add glass">
              {voiceErr && <div className="voice-err">{voiceErr}</div>}
              <div className="catrow">
                {CAT_ORDER.map((k) => (
                  <button key={k} className={`fchip ${cat === k ? "on" : ""}`}
                    style={cat === k ? { borderColor: CATS[k].color, color: CATS[k].color } : undefined}
                    onClick={() => setCat(k)}>
                    <span className="cdot" style={{ background: CATS[k].color }} />{CATS[k].label}
                  </button>
                ))}
              </div>
              <input ref={inputRef} type="text" placeholder={`Дело на ${DAY_NAMES[sel]}…`} value={title}
                onChange={(ev) => setTitle(ev.target.value)}
                onKeyDown={(ev) => ev.key === "Enter" && addTask()} aria-label="Название дела" />
              <input type="time" value={from} onChange={(ev) => setFrom(ev.target.value)} aria-label="Начало" />
              <span className="sep">—</span>
              <input type="time" value={to} onChange={(ev) => setTo(ev.target.value)} aria-label="Конец" />
              <button className={`mic ${listening ? "rec" : ""}`}
                onClick={listening ? stopVoice : startVoice}
                aria-label={listening ? "Остановить запись" : "Голосовой ввод"}>
                {listening ? <I.stop /> : <I.mic />}
              </button>
              <button className="cta" onClick={() => addTask()}>Добавить</button>
            </div>
          </>
        )}
      </div>

      <nav className="tabbar glass" aria-label="Навигация">
        <button className={view === "day" ? "on" : ""} onClick={() => setView("day")} aria-label="День"><I.list /></button>
        <button className={view === "grid" ? "on" : ""} onClick={() => setView("grid")} aria-label="Сетка"><I.grid /></button>
        <button className={view === "stats" ? "on" : ""} onClick={() => setView("stats")} aria-label="Статистика"><I.chart /></button>
        <button className={showSettings ? "on" : ""} onClick={() => setShowSettings(true)} aria-label="Настройки"><I.gear /></button>
      </nav>

      {toast && (
        <div className="toast" role="status">
          <span>{toast.msg}</span>
          {toast.action && <button onClick={toast.action.onClick}>{toast.action.label}</button>}
        </div>
      )}

      {review && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="Итоги дня">
          <div className="modal" tabIndex={-1} ref={(el) => el && el.focus()}>
            <h2>Итоги: {DAY_FULL[sel]}</h2>
            <div className="sub">Сделано, {sel < LAST ? "на завтра" : "на понедельник"} или убрать совсем.</div>
            {(() => {
              const ch = review.choices;
              const nDone = list.filter((t) => ch[t.id] === "done").length;
              const nMove = list.filter((t) => ch[t.id] === "tomorrow").length;
              const nDrop = list.filter((t) => ch[t.id] === "drop").length;
              return (
                <div className="rv-sum">
                  <div className="rv-tiles">
                    <div className="rv-tile"><b>{nDone}</b><span>закрыто</span></div>
                    <div className={`rv-tile ${nMove ? "warn" : ""}`}><b>{nMove}</b><span>перенос</span></div>
                    <div className="rv-tile"><b>{nDrop}</b><span>убрано</span></div>
                  </div>
                  <div className="rv-mtx">
                    {CAT_ORDER.map((k) => {
                      const items = list.filter((t) => catKey(t.cat) === k);
                      if (!items.length) return null;
                      const d = items.filter((t) => ch[t.id] === "done").length;
                      return (
                        <div className="rv-line" key={k}>
                          <span className="cdot" style={{ background: CATS[k].color }} />
                          <span className="rv-lbl">{CATS[k].full}</span>
                          <b>{d}/{items.length}</b>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
            {list.map((t) => {
              const c = review.choices[t.id];
              return (
                <div className="r-item" key={t.id}>
                  <div className="r-title">{t.title}</div>
                  <div className="r-time">{fmtTime(t.from, settings.timeFormat)} — {fmtTime(t.to, settings.timeFormat)} · {cat_(t.cat).full}</div>
                  <div className="seg">
                    <button className={c === "done" ? "sd" : ""} onClick={() => setReview((r) => ({ choices: { ...r.choices, [t.id]: "done" } }))}>✓ Сделано</button>
                    <button className={c === "tomorrow" ? "st" : ""} onClick={() => setReview((r) => ({ choices: { ...r.choices, [t.id]: "tomorrow" } }))}>→ {sel < LAST ? "На завтра" : "На Пн"}</button>
                    <button className={c === "drop" ? "sx" : ""} onClick={() => setReview((r) => ({ choices: { ...r.choices, [t.id]: "drop" } }))}>✕ Убрать</button>
                  </div>
                </div>
              );
            })}
            <div className="modal-actions">
              <button className="ghost" onClick={() => setReview(null)}>Отмена</button>
              <button className="cta" onClick={confirmReview}>Закрыть день</button>
            </div>
          </div>
        </div>
      )}

      {expired && !review && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="Время вышло">
          <div className="modal ask-modal" tabIndex={-1} ref={(el) => el && el.focus()}>
            <h2>Время вышло</h2>
            <div className="sub">
              <b>{expired.title}</b> — было до {fmtTime(expired.to, settings.timeFormat)}. Успел?
            </div>
            <div className="ask-acts">
              <button className="cta" onClick={() => patchTask(expired.id, { done: true, asked: true }, todayIdx)}>
                Да, сделано
              </button>
              {(expired.ext || 0) < MAX_EXT && (
                <button className="ghost" onClick={() => extendTask(expired, todayIdx)}>
                  Ещё {EXT_MIN} мин (осталось {MAX_EXT - (expired.ext || 0)})
                </button>
              )}
              <button className="ghost" onClick={() => { moveToNextDay(expired.id, todayIdx); }}>
                Не успел — на завтра
              </button>
              <button className="linkish" onClick={() => patchTask(expired.id, { asked: true }, todayIdx)}>
                Не успел, оставить незакрытым
              </button>
            </div>
            <div className="ask-note">Перенос и незакрытые дела портят статистику — это честно и так задумано.</div>
          </div>
        </div>
      )}

      {showCalendar && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="Календарь" onClick={() => setShowCalendar(false)}>
          <div className="modal cal-modal" tabIndex={-1} ref={(el) => el && el.focus()} onClick={(e) => e.stopPropagation()}>
            <div className="cal-head">
              <button className="icon-btn" onClick={() => setCalMonth((m) => { const d = new Date(m); d.setMonth(d.getMonth() - 1); return d; })} aria-label="Прошлый месяц"><I.chevL /></button>
              <h2>{["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"][calMonth.getMonth()]} {calMonth.getFullYear()}</h2>
              <button className="icon-btn" onClick={() => setCalMonth((m) => { const d = new Date(m); d.setMonth(d.getMonth() + 1); return d; })} aria-label="Следующий месяц"><I.chevR /></button>
            </div>
            <div className="cal-grid cal-dow">
              {DAY_NAMES.map((n) => <span key={n} className="cal-dowc">{n}</span>)}
            </div>
            <div className="cal-grid">
              {(() => {
                const first = new Date(calMonth.getFullYear(), calMonth.getMonth(), 1);
                const lead = (first.getDay() + 6) % 7; // сколько пустых до понедельника
                const daysInMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 0).getDate();
                const cells = [];
                for (let i = 0; i < lead; i++) cells.push(<span key={`e${i}`} className="cal-cell empty" />);
                for (let dnum = 1; dnum <= daysInMonth; dnum++) {
                  const dt = new Date(calMonth.getFullYear(), calMonth.getMonth(), dnum);
                  const dk = dateKey(dt);
                  const wkKey = dateKey(mondayOf(dt));
                  const inViewWeek = wkKey === viewMondayKey;
                  const isToday = dk === todayKey;
                  const wkData = wkKey === viewMondayKey ? { days } : weeks[wkKey];
                  const dIdx = (dt.getDay() + 6) % 7;
                  const hasTasks = wkData && wkData.days && (wkData.days[dIdx] || []).length > 0;
                  cells.push(
                    <button key={dk}
                      className={`cal-cell ${inViewWeek ? "inweek" : ""} ${inViewWeek && dIdx === 0 ? "wk-l" : ""} ${inViewWeek && dIdx === 6 ? "wk-r" : ""}`}
                      onClick={() => { switchWeek(wkKey); setSel(dIdx); setShowCalendar(false); }}>
                      <span className={`cal-num ${isToday ? "today" : ""}`}>{dnum}</span>
                      <span className={`cal-dot ${hasTasks ? "" : "blank"}`} />
                    </button>
                  );
                }
                return cells;
              })()}
            </div>
            <div className="modal-actions">
              <button className="ghost" onClick={() => { const d = mondayOf(new Date()); d.setDate(1); setCalMonth(d); goToday(); setShowCalendar(false); }}>Сегодня</button>
              <button className="cta" onClick={() => setShowCalendar(false)}>Готово</button>
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="Настройки">
          <div className="modal" tabIndex={-1} ref={(el) => el && el.focus()}>
            <h2>Настройки</h2>
            <div className="sub">Применяются сразу и хранятся на этом устройстве.</div>

            <div className="set-sec">
              <div className="set-h">Инструменты</div>
              <div className="danger-row">
                <button className="ghost" onClick={() => { setShowSettings(false); setShowRoutines(true); }}><I.rep /> Повторы</button>
                <button className="ghost" onClick={toggleNotif}>{notifOn ? <I.bell /> : <I.bellOff />} {notifOn ? "Увед. вкл" : "Увед. выкл"}</button>
              </div>
            </div>

            <div className="set-sec">
              <div className="set-h">Оформление</div>
              <div className="set-row">
                <span className="lbl">Тема</span>
                <div className="seg2">
                  <button className={settings.theme === "dark" ? "on" : ""} onClick={() => updateSetting({ theme: "dark" })}>Тёмная</button>
                  <button className={settings.theme === "light" ? "on" : ""} onClick={() => updateSetting({ theme: "light" })}>Светлая</button>
                  <button className={settings.theme === "system" ? "on" : ""} onClick={() => updateSetting({ theme: "system" })}>Как в системе</button>
                </div>
              </div>
              <div className="set-row">
                <span className="lbl">Акцент</span>
                <div className="seg2">
                  {Object.keys(ACCENT_PRESETS).map((k) => (
                    <button key={k} className={`swatch ${settings.accent === k ? "on" : ""}`}
                      style={{ background: ACCENT_PRESETS[k].acc }} onClick={() => updateSetting({ accent: k })}
                      aria-label={k === "green" ? "Кислотный зелёный" : k === "violet" ? "Контрастный фиолетовый" : "Сливочный"}
                      title={k === "green" ? "Кислотный зелёный" : k === "violet" ? "Контрастный фиолетовый" : "Сливочный"} />
                  ))}
                </div>
              </div>
            </div>

            <div className="set-sec">
              <div className="set-h">Неделя и время</div>
              <div className="set-row">
                <span className="lbl">Формат времени</span>
                <div className="seg2">
                  <button className={settings.timeFormat === 24 ? "on" : ""} onClick={() => updateSetting({ timeFormat: 24 })}>24 ч</button>
                  <button className={settings.timeFormat === 12 ? "on" : ""} onClick={() => updateSetting({ timeFormat: 12 })}>12 ч</button>
                </div>
              </div>
              <div className="set-row">
                <span className="lbl">Рабочие часы<small>для распределения копилки</small></span>
                <div className="seg2">
                  <input type="time" value={settings.workStart} onChange={(e) => updateSetting({ workStart: e.target.value })} />
                  <span className="sep">—</span>
                  <input type="time" value={settings.workEnd} onChange={(e) => updateSetting({ workEnd: e.target.value })} />
                </div>
              </div>
              <div className="set-row">
                <span className="lbl">Длительность дела по умолчанию</span>
                <select className="set-sel" value={settings.defaultDuration} onChange={(e) => updateSetting({ defaultDuration: Number(e.target.value) })}>
                  <option value={30}>30 мин</option>
                  <option value={45}>45 мин</option>
                  <option value={60}>60 мин</option>
                  <option value={90}>90 мин</option>
                  <option value={120}>120 мин</option>
                </select>
              </div>
            </div>

            <div className="set-sec">
              <div className="set-h">Уведомления</div>
              <div className="set-note">Работают, только пока приложение открыто на экране. В фоне или при заблокированном телефоне не придут — это ограничение веб-версии, не баг.</div>
              <div className="set-row">
                <span className="lbl">Напоминать за</span>
                <select className="set-sel" value={settings.notifyLead} onChange={(e) => updateSetting({ notifyLead: Number(e.target.value) })}>
                  <option value={5}>5 мин</option>
                  <option value={10}>10 мин</option>
                  <option value={15}>15 мин</option>
                  <option value={30}>30 мин</option>
                </select>
              </div>
              <div className="set-row">
                <span className="lbl">Напомнить закрыть день<small>фиксированное время, помимо конца расписания</small></span>
                <div className="seg2">
                  <input type="time" value={settings.reviewTime} onChange={(e) => updateSetting({ reviewTime: e.target.value })} />
                  {settings.reviewTime && <button className="time-clear" onClick={() => updateSetting({ reviewTime: "" })}>выкл</button>}
                </div>
              </div>
            </div>

            <div className="set-sec">
              <div className="set-h">Данные</div>
              <div className="danger-row">
                <button className="ghost" onClick={exportData}><I.down /> Экспорт JSON</button>
                <button className="ghost" onClick={() => fileInputRef.current && fileInputRef.current.click()}><I.up /> Импорт JSON</button>
                <input ref={fileInputRef} type="file" accept="application/json" className="file-hidden" aria-label="Импорт JSON"
                  onChange={(e) => { importData(e.target.files[0]); e.target.value = ""; }} />
              </div>
              <div className="danger-row" style={{ marginTop: 8 }}>
                <button className="danger-btn" onClick={resetWeek}>{confirmAction === "week" ? "Точно? Нажми ещё раз" : "Сбросить неделю"}</button>
                <button className="danger-btn" onClick={resetAll}>{confirmAction === "all" ? "Точно? Нажми ещё раз" : "Сбросить всё"}</button>
              </div>
              {settingsMsg && <div className="set-msg">{settingsMsg}</div>}
            </div>

            <div className="set-sec">
              <div className="set-ver">Моя неделя · v1.1</div>
              <div className="set-ver">iPhone: Safari → «Поделиться» → «На экран "Домой"»</div>
            </div>

            <div className="modal-actions">
              <button className="cta" onClick={() => { setShowSettings(false); setConfirmAction(null); setSettingsMsg(""); }}>Готово</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Школьная сетка недели (с перетаскиванием) ----------
const CAT_LETTER = { iu: "ВС", in: "В", nu: "С", nn: "М" };

function DayGrid({ days, todayIdx, sel, nowMin, dayDate, onPrev, onNext, onOpenCal, onMove, timeFormat }) {
  const H0 = 7, H1 = 23, PX = 56;   // час = 56px: колонка одна, места хватает
  const list = days[sel] || [];
  const height = (H1 - H0) * PX;
  const hours = [];
  for (let h = H0; h < H1; h++) hours.push(h);
  const colRef = useRef(null);
  const dragRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const d = dayDate(sel);
  const isToday = sel === todayIdx;

  // Перетаскивание только по вертикали — колонка одна, менять день мышью больше не нужно
  const startDrag = (ev, t) => {
    if (ev.button !== undefined && ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    const info = { id: t.id, from: t.from, to: t.to, y0: ev.clientY, dy: 0, moved: false };
    dragRef.current = info;
    const move = (e) => {
      const i = dragRef.current; if (!i) return;
      i.dy = e.clientY - i.y0;
      if (Math.abs(i.dy) > 6) i.moved = true;
      setDrag({ ...i });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const i = dragRef.current;
      dragRef.current = null; setDrag(null);
      if (!i || !i.moved) return;
      const dur = toMin(i.to) - toMin(i.from);
      const dMin = Math.round(((i.dy / PX) * 60) / 15) * 15;   // шаг 15 минут
      let ns = toMin(i.from) + dMin;
      ns = Math.max(H0 * 60, Math.min(H1 * 60 - dur, ns));
      onMove(i.id, sel, sel, toHHMM(ns), toHHMM(ns + dur));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <section className="card daycard" aria-label="Расписание дня">
      <div className="dg-head">
        <button className="wn-arrow" onClick={onPrev} aria-label="Предыдущий день"><I.chevL /></button>
        <button className="dg-title" onClick={onOpenCal}>
          <b className={isToday ? "on" : ""}>{DAY_FULL[sel]}</b>
          <span>{d.getDate()} {MONTHS[d.getMonth()]}{isToday ? " · сегодня" : ""}</span>
        </button>
        <button className="wn-arrow" onClick={onNext} aria-label="Следующий день"><I.chevR /></button>
      </div>

      <div className="dg-body">
        <div className="dg-hours" style={{ height }}>
          {hours.map((h) => (
            <div key={h} className="dg-hour" style={{ top: (h - H0) * PX }}>{pad(h)}:00</div>
          ))}
        </div>

        <div className="dg-col" ref={colRef} style={{ height }}>
          {hours.map((h) => (
            <div key={h} className="dg-line" style={{ top: (h - H0) * PX }} />
          ))}

          {list.map((t) => {
            const s0 = Math.max(toMin(t.from), H0 * 60);
            const e0 = Math.min(toMin(t.to), H1 * 60);
            if (e0 <= s0) return null;
            const c = cat_(t.cat);
            const isDrag = drag && drag.id === t.id;
            const snapY = isDrag ? (Math.round(((drag.dy / PX) * 60) / 15) * 15 / 60) * PX : 0;
            const tall = (e0 - s0) >= 45;   // в высоком блоке помещается и заметка
            return (
              <div key={t.id} className={`dg-block ${t.done ? "b-done" : ""} ${isDrag ? "dragging" : ""}`}
                onPointerDown={(ev) => startDrag(ev, t)}
                style={{
                  top: ((s0 - H0 * 60) / 60) * PX + 1,
                  height: Math.max(26, ((e0 - s0) / 60) * PX - 3),
                  background: c.color + "22",
                  borderLeft: `3px solid ${c.color}`,
                  transform: isDrag ? `translateY(${snapY}px)` : undefined,
                }}>
                <b>{t.title}</b>
                <i>{fmtTime(t.from, timeFormat)}–{fmtTime(t.to, timeFormat)} · {c.label}</i>
                {tall && t.note && <em>{t.note}</em>}
              </div>
            );
          })}

          {isToday && nowMin >= H0 * 60 && nowMin <= H1 * 60 && (
            <div className="dg-now" style={{ top: ((nowMin - H0 * 60) / 60) * PX }} />
          )}

          {list.length === 0 && <div className="dg-empty">На этот день дел нет</div>}
        </div>
      </div>

      <div className="grid-hint">Потяни блок — сдвинуть время · стрелки и дата — сменить день</div>
    </section>
  );
}

// ---------- PIN-экран ----------
// Это защита от чужого взгляда при передаче телефона, а не настоящая security:
// PIN хранится в localStorage и виден через консоль браузера. Для личного планировщика достаточно.
const PIN_KEY = "myday:pin";
const PIN_UNLOCK_KEY = "myday:unlocked";

function PinGate() {
  const [savedPin, setSavedPin] = useState(() => { try { return localStorage.getItem(PIN_KEY) || ""; } catch (e) { return ""; } });
  const [unlocked, setUnlocked] = useState(() => { try { return sessionStorage.getItem(PIN_UNLOCK_KEY) === "1"; } catch (e) { return false; } });
  const [input, setInput] = useState("");
  const [mode, setMode] = useState(savedPin ? "enter" : "setup"); // 'setup' | 'confirm' | 'enter'
  const [firstPin, setFirstPin] = useState("");
  const [err, setErr] = useState("");

  const press = (d) => {
    setErr("");
    if (input.length >= 4) return;
    const next = input + d;
    setInput(next);
    if (next.length !== 4) return;

    if (mode === "setup") {
      setFirstPin(next); setInput(""); setMode("confirm");
    } else if (mode === "confirm") {
      if (next === firstPin) {
        try { localStorage.setItem(PIN_KEY, next); sessionStorage.setItem(PIN_UNLOCK_KEY, "1"); } catch (e) {}
        setSavedPin(next); setUnlocked(true);
      } else {
        setErr("Коды не совпали, начни заново"); setInput(""); setFirstPin(""); setMode("setup");
      }
    } else {
      if (next === savedPin) {
        try { sessionStorage.setItem(PIN_UNLOCK_KEY, "1"); } catch (e) {}
        setUnlocked(true);
      } else {
        setErr("Неверный код"); setInput("");
      }
    }
  };
  const del = () => setInput((v) => v.slice(0, -1));

  if (unlocked) return <WeekPlanner />;

  const title = mode === "setup" ? "Придумай PIN" : mode === "confirm" ? "Повтори PIN" : "Введи PIN";
  const sub = mode === "setup" ? "4 цифры — защитит приложение от чужого взгляда" : mode === "confirm" ? "Ещё раз, чтобы не ошибиться" : "";

  return (
    <div className="pin-screen">
      <style>{`
        .pin-screen{min-height:100vh;background:#141416;color:#F5F5F5;display:flex;flex-direction:column;
          align-items:center;justify-content:center;gap:28px;font-family:'Inter',-apple-system,sans-serif;padding:24px}
        .pin-title{font-size:20px;font-weight:800;letter-spacing:-0.02em}
        .pin-sub{font-size:13px;color:#9B9B9E;margin-top:4px;text-align:center;min-height:16px}
        .pin-err{color:#E8A0A0}
        .pin-dots{display:flex;gap:14px}
        .pin-dot{width:14px;height:14px;border-radius:50%;border:1.5px solid #3A3A3F;transition:background .15s,border-color .15s}
        .pin-dot.on{background:#4F46E5;border-color:#4F46E5}
        .pin-pad{display:grid;grid-template-columns:repeat(3,72px);gap:14px}
        .pin-key{width:72px;height:72px;border-radius:50%;background:#1E1E21;border:1px solid #2C2C30;
          color:#F5F5F5;font-size:24px;font-weight:600;cursor:pointer}
        .pin-key:active{background:#26262A}
        .pin-key.ghost{background:none;border:none;color:#9B9B9E;font-size:14px}
      `}</style>
      <div style={{ textAlign: "center" }}>
        <div className="pin-title">{title}</div>
        <div className={`pin-sub ${err ? "pin-err" : ""}`}>{err || sub}</div>
      </div>
      <div className="pin-dots">
        {[0, 1, 2, 3].map((i) => <span key={i} className={`pin-dot ${i < input.length ? "on" : ""}`} />)}
      </div>
      <div className="pin-pad">
        {["1","2","3","4","5","6","7","8","9"].map((d) => (
          <button key={d} className="pin-key" onClick={() => press(d)}>{d}</button>
        ))}
        <span />
        <button className="pin-key" onClick={() => press("0")}>0</button>
        <button className="pin-key ghost" onClick={del} aria-label="Стереть">⌫</button>
      </div>
    </div>
  );
}

export default function App() {
  return <PinGate />;
}
