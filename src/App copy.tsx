import React, { useEffect, useMemo, useRef, useState } from "react";

import jsPDF from "jspdf";
import { toPng } from "html-to-image";


/* PART 1/4 — Types + constants + helpers + units + psychrometric math */

type Point = { db: number; rh: number; wb: number; dp: number; W: number; h: number; P: number };
type PointInputMode = "dbRh" | "dbWb";

type PointNode = {
  id: string;
  name: string;
  dbInput: number;
  rhInput: number;
  wbInput: number;
  inputMode: PointInputMode;
  flowInput: number;
  flowType: "mass" | "volume";
  chartDx: number;
  chartDy: number;
};

type ProcessKind = "sensibleCooling" | "cooling" | "heating" | "mixing" | "humidifying" | "dehumidifying";

type ProcessEdge = {
  id: string;
  type: ProcessKind;
  name: string;
  sourceId: string;
  targetId: string;
  source2Id?: string;          // mixing
  leavingDbInput?: number;     // sensibleCooling/heating
  adpInput?: number;           // cooling
  bfInput?: number;            // cooling
  moistureInput?: number;      // humidifying/dehumidifying
  humidifierMode?: "steam" | "evaporative";
};

type SolvedPoint = Point & {
  v: number;
  mda: number;
  vol: number;
  isCalculated: boolean;
  calculatedBy?: string;
  nodeRef: PointNode;
};

type SolvedSegment = {
  id: string;
  edge: ProcessEdge;
  from: SolvedPoint;
  to: SolvedPoint;
  totalKW: number;
  sensKW: number;
  latKW: number;
  shr: number;
  moistureKgHr: number;
  mdaIn: number;
  mdaOut: number;
};

type SavedProject = {
  id: string;
  name: string;
  savedAt: string;
  pressureMode: "altitude" | "pressure";
  altitude: number;
  pressure: number;
  nodes: PointNode[];
  edges: ProcessEdge[];
  sequence: SequenceItem[];
};

type SequenceItem =
  | { id: string; kind: "point"; nodeId: string }
  | { id: string; kind: "process"; edgeId: string };

const STORAGE_KEY = "psychrometric_projects_v13";

const CHART = {
  width: 1040,
  height: 600,
  marginLeft: 70,
  marginRight: 70,
  marginTop: 20,
  marginBottom: 52,
  minDb: -10,
  maxDb: 50,
  minW: 0,
  maxW: 0.03,
} as const;

const POINT_COLORS = ["#2563eb","#dc2626","#059669","#7c3aed","#ea580c","#0891b2","#be123c","#65a30d"];

function uid() { return Math.random().toString(36).slice(2, 9); }
function safeNum(val: unknown, fallback = 0) { const n = Number(val); return Number.isFinite(n) ? n : fallback; }
function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }
function arrayMove<T>(arr: T[], from: number, to: number) {
  const a = [...arr];
  const [it] = a.splice(from, 1);
  a.splice(to, 0, it);
  return a;
}

function pillStyle(): React.CSSProperties {
  return {
    display: "inline-flex",
    gap: 6,
    alignItems: "center",
    padding: "3px 8px",
    borderRadius: 999,
    border: "1px solid #e2e8f0",
    background: "#f8fafc",
    fontSize: 12,
    fontWeight: 800,
    color: "#0f172a",
  };
}

function useUnits(isIP: boolean) {
  return useMemo(() => ({
    isIP,
    temp: { toDisp: (c:number)=> isIP ? c*1.8+32 : c, toSI: (x:number)=> isIP ? (x-32)/1.8 : x, u: isIP ? "°F":"°C" },
    mda:  { toDisp: (kgph:number)=> isIP ? kgph*2.20462 : kgph, toSI: (lbph:number)=> isIP ? lbph/2.20462 : lbph, u: isIP ? "lb/h":"kg/h" },
    vol:  { toDisp: (m3h:number)=> isIP ? m3h/1.69901 : m3h, toSI: (cfm:number)=> isIP ? cfm*1.69901 : cfm, u: isIP ? "CFM":"CMH" },
    alt:  { toDisp: (m:number)=> isIP ? m*3.28084 : m, toSI: (ft:number)=> isIP ? ft/3.28084 : ft, u: isIP ? "ft":"m" },
    pres: { toDisp: (kpa:number)=> isIP ? kpa*0.145038 : kpa, toSI: (psi:number)=> isIP ? psi/0.145038 : psi, u: isIP ? "psi":"kPa" },
    load: { toDisp: (kw:number)=> isIP ? kw/3.51685 : kw, u: isIP ? "Tons":"kW" },
    enth: { toDisp: (h:number)=> isIP ? h*0.429923 : h, u: isIP ? "Btu/lb":"kJ/kg" },
    w:    { toDisp: (w:number)=> isIP ? w*7000 : w, u: isIP ? "gr/lb":"kg/kg" },
  }), [isIP]);
}

// Psychrometric math (SI internal)
function calcPressureFromAltitude(altMeters: number) {
  return safeNum(101.325 * Math.pow(1 - 2.25577e-5 * altMeters, 5.2559), 101.325);
}
function satPressure(Tc: number) {
  const TK = Tc + 273.15;
  if (TK <= 0) return 0.001;
  const C8 = -5.8002206e3, C9 = 1.3914993, C10 = -4.8640239e-2,
        C11 = 4.1764768e-5, C12 = -1.4452093e-8, C13 = 6.5459673;
  const lnPws = C8 / TK + C9 + C10 * TK + C11 * TK ** 2 + C12 * TK ** 3 + C13 * Math.log(TK);
  return safeNum(Math.exp(lnPws) / 1000, 0.001);
}
function humidityRatio(dbC: number, rhPct: number, PkPa: number) {
  const rh = clamp(rhPct, 0.01, 100);
  const Pw = satPressure(dbC) * (rh / 100);
  if (PkPa - Pw <= 0) return CHART.maxW;
  return safeNum((0.62194 * Pw) / (PkPa - Pw), 0);
}
function enthalpy(dbC: number, W: number) { return safeNum(1.006 * dbC + W * (2501 + 1.86 * dbC), 0); }
function dewPoint(dbC: number, rhPct: number) {
  const rh = clamp(rhPct, 0.01, 100);
  const Pw = satPressure(dbC) * (rh / 100);
  if (Pw <= 0) return -50;
  const approx = 243.5 / (17.67 / Math.log(Pw / 0.6112) - 1);
  return safeNum(clamp(approx, -60, dbC), dbC);
}
function rhFromW(dbC: number, W: number, PkPa: number) {
  const Pw = (PkPa * W) / (0.62194 + W);
  const rh = (Pw / satPressure(dbC)) * 100;
  return safeNum(clamp(rh, 0, 100), 0);
}
function dbFromHW(h: number, W: number) { return safeNum((h - 2501 * W) / (1.006 + 1.86 * W), 20); }
function specificVolume(dbC: number, W: number, PkPa: number) { return safeNum(0.287042 * (dbC + 273.15) * (1 + 1.6078 * W) / PkPa, 0.83); }

function humidityRatioFromDbWb(dbC: number, wbC: number, PkPa: number) {
  const pws_wb = satPressure(wbC);
  const Ws = (0.62194 * pws_wb) / (PkPa - pws_wb);
  const num = (2501 - 2.326 * wbC) * Ws - 1.006 * (dbC - wbC);
  const den = 2501 + 1.86 * dbC - 4.186 * wbC;
  const W = num / den;
  return safeNum(clamp(W, 0, CHART.maxW), 0);
}
function wetBulbFromDbRh(dbC: number, rhPct: number, PkPa: number) {
  const targetW = humidityRatio(dbC, rhPct, PkPa);
  let low = -50, high = dbC, guess = (low + high) / 2;
  for (let i = 0; i < 18; i++) {
    const Wg = humidityRatioFromDbWb(dbC, guess, PkPa);
    if (Wg > targetW) high = guess; else low = guess;
    guess = (low + high) / 2;
  }
  return safeNum(guess, dbC);
}
function pointFromDbRh(dbC: number, rhPct: number, PkPa: number): Point {
  const rh = clamp(rhPct, 0.01, 100);
  const W = humidityRatio(dbC, rh, PkPa);
  const wb = wetBulbFromDbRh(dbC, rh, PkPa);
  return { db: dbC, rh, wb, dp: dewPoint(dbC, rh), W, h: enthalpy(dbC, W), P: PkPa };
}
function pointFromDbWb(dbC: number, wbC: number, PkPa: number): Point {
  const wb = clamp(wbC, -60, dbC);
  const Wraw = humidityRatioFromDbWb(dbC, wb, PkPa);
  const Wsat = humidityRatio(dbC, 100, PkPa);
  const W = clamp(Wraw, 0, Wsat);
  const rh = rhFromW(dbC, W, PkPa);
  return { db: dbC, rh, wb, dp: dewPoint(dbC, rh), W, h: enthalpy(dbC, W), P: PkPa };
}
function pointFromDbW(dbC: number, W: number, PkPa: number): Point {
  const Wsat = humidityRatio(dbC, 100, PkPa);
  const Wc = clamp(W, 0, Wsat);
  const rh = rhFromW(dbC, Wc, PkPa);
  const wb = wetBulbFromDbRh(dbC, rh, PkPa);
  return { db: dbC, rh, wb, dp: dewPoint(dbC, rh), W: Wc, h: enthalpy(dbC, Wc), P: PkPa };
}
function dewPointFromW(W: number, PkPa: number) {
  const Wc = clamp(W, 0, CHART.maxW);
  const Pw = (PkPa * Wc) / (0.62194 + Wc);
  let lo = -60, hi = 80;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    const pmid = satPressure(mid);
    if (pmid > Pw) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

/* PART 2/4 — Sequence helpers + defaultProcess + solver + UI atoms + palette */

function makeInitialSequence(nodes: PointNode[], edges: ProcessEdge[]): SequenceItem[] {
    return [
      ...nodes.map((n) => ({ id: `seq-${n.id}`, kind: "point" as const, nodeId: n.id })),
      ...edges.map((e) => ({ id: `seq-${e.id}`, kind: "process" as const, edgeId: e.id })),
    ];
  }
  
  function applySequenceToEdges(sequence: SequenceItem[], edges: ProcessEdge[]): ProcessEdge[] {
    const edgeMap = new Map(edges.map((e) => [e.id, { ...e }]));
    for (let i = 0; i < sequence.length; i++) {
      const it = sequence[i];
      if (it.kind !== "process") continue;
  
      let leftPoint: string | null = null;
      let rightPoint: string | null = null;
  
      for (let j = i - 1; j >= 0; j--) {
        const a = sequence[j];
        if (a.kind === "point") { leftPoint = a.nodeId; break; }
      }
      for (let j = i + 1; j < sequence.length; j++) {
        const b = sequence[j];
        if (b.kind === "point") { rightPoint = b.nodeId; break; }
      }
  
      const e = edgeMap.get(it.edgeId);
      if (!e) continue;
      if (leftPoint) e.sourceId = leftPoint;
      if (rightPoint) e.targetId = rightPoint;
      edgeMap.set(e.id, e);
    }
    return Array.from(edgeMap.values());
  }
  
  function defaultProcess(type: ProcessKind): Omit<ProcessEdge, "id" | "sourceId" | "targetId"> {
    switch (type) {
      case "mixing":           return { type, name: "Mixing", source2Id: "" };
      case "cooling":          return { type, name: "Cooling (Coil)", adpInput: 10, bfInput: 0.1 };
      case "sensibleCooling":  return { type, name: "Sensible Cooling", leavingDbInput: 18 };
      case "heating":          return { type, name: "Heating", leavingDbInput: 30 };
      case "humidifying":      return { type, name: "Humidifying", moistureInput: 10, humidifierMode: "steam" };
      case "dehumidifying":    return { type, name: "Dehumidifying", moistureInput: 10 };
    }
  }
  
  function solveNetwork(nodes: PointNode[], edges: ProcessEdge[], P: number, isIP: boolean) {
    const ptMap = new Map<string, SolvedPoint>();
    const segments: SolvedSegment[] = [];
  
    // Base points from node inputs
    for (const n of nodes) {
      const dbSI = safeNum(isIP ? (n.dbInput - 32) / 1.8 : n.dbInput, 25);
  
      let base: Point;
      if (n.inputMode === "dbWb") {
        const wbSI = safeNum(isIP ? (n.wbInput - 32) / 1.8 : n.wbInput, dbSI);
        base = pointFromDbWb(dbSI, wbSI, P);
      } else {
        base = pointFromDbRh(dbSI, safeNum(n.rhInput, 50), P);
      }
  
      const v = specificVolume(base.db, base.W, P);
      const flowIn = safeNum(n.flowInput, 0);
  
      let mdaSI = 0, volSI = 0;
      if (n.flowType === "mass") {
        mdaSI = isIP ? flowIn / 2.20462 : flowIn;
        volSI = mdaSI * v;
      } else {
        volSI = isIP ? flowIn * 1.69901 : flowIn;
        mdaSI = v > 0 ? volSI / v : 0;
      }
  
      ptMap.set(n.id, { ...base, v, mda: mdaSI, vol: volSI, isCalculated: false, nodeRef: n });
    }
  
    for (let pass = 0; pass < 3; pass++) {
      segments.length = 0;
  
      for (const edge of edges) {
        const src1 = ptMap.get(edge.sourceId);
        if (!src1) continue;
  
        const targetNode = nodes.find((n) => n.id === edge.targetId);
        if (!targetNode) continue;
  
        let outPt: Point | null = null;
        let mdaOut = src1.mda;
  
        let totalKW = 0, sensKW = 0, latKW = 0, shr = 1, moist = 0;
  
        if (edge.type === "mixing") {
          if (!edge.source2Id) continue;
          const src2 = ptMap.get(edge.source2Id);
          if (!src2) continue;
  
          const mTotal = src1.mda + src2.mda;
          if (mTotal <= 0) continue;
  
          const hMix = (src1.mda * src1.h + src2.mda * src2.h) / mTotal;
          const WMix = (src1.mda * src1.W + src2.mda * src2.W) / mTotal;
  
          outPt = pointFromDbW(dbFromHW(hMix, WMix), WMix, P);
          mdaOut = mTotal;
  
          totalKW = safeNum((mdaOut * (outPt.h - src1.h)) / 3600);
          sensKW  = safeNum((mdaOut * 1.006 * (outPt.db - src1.db)) / 3600);
          latKW   = totalKW - sensKW;
          moist   = safeNum(mdaOut * (outPt.W - src1.W));
        } else if (edge.type === "cooling") {
          const adpSI = safeNum(isIP ? ((edge.adpInput || 0) - 32) / 1.8 : (edge.adpInput || 0), 10);
          const bf = clamp(safeNum(edge.bfInput, 0.1), 0, 1);
  
          const lDb = bf * src1.db + (1 - bf) * adpSI;
          const lW  = bf * src1.W  + (1 - bf) * humidityRatio(adpSI, 100, P);
  
          outPt = pointFromDbW(lDb, lW, P);
  
          totalKW = safeNum((mdaOut * (outPt.h - src1.h)) / 3600);
          sensKW  = safeNum((mdaOut * 1.006 * (outPt.db - src1.db)) / 3600);
          latKW   = totalKW - sensKW;
          moist   = safeNum(mdaOut * (outPt.W - src1.W));
        } else if (edge.type === "sensibleCooling" || edge.type === "heating") {
          const ldbSI = safeNum(
            isIP ? ((edge.leavingDbInput || 0) - 32) / 1.8 : (edge.leavingDbInput || 0),
            src1.db
          );
          outPt = pointFromDbW(ldbSI, src1.W, P);
  
          totalKW = safeNum((mdaOut * (outPt.h - src1.h)) / 3600);
          sensKW  = totalKW;
          latKW   = 0;
          moist   = 0;
        } else if (edge.type === "humidifying") {
          const mAdd = safeNum(isIP ? (edge.moistureInput || 0) / 2.20462 : (edge.moistureInput || 0), 0);
          const dW = mAdd / (mdaOut || 1);
          const Wt = src1.W + dW;
  
          outPt = (edge.humidifierMode || "steam") === "steam"
            ? pointFromDbW(dbFromHW(src1.h + dW * 2680, Wt), Wt, P)
            : pointFromDbW(dbFromHW(src1.h, Wt), Wt, P);
  
          moist = mAdd;
          totalKW = safeNum((mdaOut * (outPt.h - src1.h)) / 3600);
          sensKW  = safeNum((mdaOut * 1.006 * (outPt.db - src1.db)) / 3600);
          latKW   = totalKW - sensKW;
        } else if (edge.type === "dehumidifying") {
          const mRem = safeNum(isIP ? (edge.moistureInput || 0) / 2.20462 : (edge.moistureInput || 0), 0);
          const dW = mRem / (mdaOut || 1);
          const Wt = Math.max(0, src1.W - dW);
  
          outPt = pointFromDbW(src1.db, Wt, P);
  
          moist = -mRem;
          totalKW = safeNum((mdaOut * (outPt.h - src1.h)) / 3600);
          sensKW  = safeNum((mdaOut * 1.006 * (outPt.db - src1.db)) / 3600);
          latKW   = totalKW - sensKW;
        }
  
        if (!outPt) continue;
  
        const vOut = specificVolume(outPt.db, outPt.W, P);
        const solvedTo: SolvedPoint = {
          ...outPt,
          v: vOut,
          mda: mdaOut,
          vol: mdaOut * vOut,
          isCalculated: true,
          calculatedBy: edge.name,
          nodeRef: targetNode,
        };
  
        ptMap.set(edge.targetId, solvedTo);
  
        shr = Math.abs(totalKW) > 0.001 ? safeNum(sensKW / totalKW, 1) : 1;
  
        segments.push({
          id: edge.id,
          edge,
          from: src1,
          to: solvedTo,
          totalKW,
          sensKW,
          latKW,
          shr,
          moistureKgHr: moist,
          mdaIn: src1.mda,
          mdaOut,
        });
      }
    }
  
    return { ptMap, segments };
  }
  
  // Palette drag (HTML5)
  type DragPayload = { from: "palette"; processType: ProcessKind } | { from: "noop" };
  function setDragData(e: React.DragEvent, p: DragPayload) {
    e.dataTransfer.setData("application/json", JSON.stringify(p));
    e.dataTransfer.effectAllowed = "copy";
  }
  function getDragData(e: React.DragEvent): DragPayload | null {
    try { return JSON.parse(e.dataTransfer.getData("application/json")); } catch { return null; }
  }
  
  const PROCESS_PALETTE: { type: ProcessKind; label: string; symbol: string; hint: string; color: string }[] = [
    { type: "sensibleCooling", label: "Sensible Cooling", symbol: "←", hint: "Horizontal left (constant W)", color: "#f59e0b" },
    { type: "cooling",         label: "Cooling",          symbol: "↙", hint: "Down-left (cooling + dehumidification)", color: "#06b6d4" },
    { type: "heating",         label: "Heating",          symbol: "→", hint: "Horizontal right (constant W)", color: "#ef4444" },
    { type: "mixing",          label: "Mixing",           symbol: "⇉", hint: "Blend two streams", color: "#7c3aed" },
    { type: "humidifying",     label: "Humidifying",      symbol: "↑", hint: "Up (adds moisture)", color: "#22c55e" },
    { type: "dehumidifying",   label: "Dehumidifying",    symbol: "↓", hint: "Down (removes moisture)", color: "#0ea5e9" },
  ];

  /* PART 3/4 — App UI: chain editor + palette drop + arrow move buttons */

export default function App() {
    const [isIP, setIsIP] = useState(false);
    const units = useUnits(isIP);
  
    // Project
    const [projectName, setProjectName] = useState("Mechanical IL Psychrometric");
    const [savedProjects, setSavedProjects] = useState<SavedProject[]>([]);
    const [showProjects, setShowProjects] = useState(false);
  
    // Environment
    const [pressureMode, setPressureMode] = useState<"altitude" | "pressure">("altitude");
    const [altitude, setAltitude] = useState(0);
    const [pressure, setPressure] = useState(101.325);
  
    // Default: only Outside Air
    const [nodes, setNodes] = useState<PointNode[]>([
      {
        id: "oa",
        name: "Outside Air",
        dbInput: 35,
        rhInput: 50,
        wbInput: 26,
        inputMode: "dbRh",
        flowInput: 3000,
        flowType: "volume",
        chartDx: 10,
        chartDy: -10,
      },
    ]);
    const [edges, setEdges] = useState<ProcessEdge[]>([]);
    const [sequence, setSequence] = useState<SequenceItem[]>(() => makeInitialSequence(
      [{
        id: "oa",
        name: "Outside Air",
        dbInput: 35,
        rhInput: 50,
        wbInput: 26,
        inputMode: "dbRh",
        flowInput: 3000,
        flowType: "volume",
        chartDx: 10,
        chartDy: -10,
      }],
      []
    ));
  
    // Load saved projects
    useEffect(() => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) setSavedProjects(JSON.parse(raw));
      } catch {}
    }, []);
  
    // Keep sequence consistent with nodes/edges existence
    useEffect(() => {
      setSequence(prev => {
        const keepNodes = new Set(nodes.map(n => n.id));
        const keepEdges = new Set(edges.map(e => e.id));
  
        const filtered = prev.filter(it => it.kind === "point" ? keepNodes.has(it.nodeId) : keepEdges.has(it.edgeId));
  
        const haveN = new Set(filtered.filter(i => i.kind === "point").map(i => i.nodeId));
        const haveE = new Set(filtered.filter(i => i.kind === "process").map(i => i.edgeId));
  
        const addN = nodes.filter(n => !haveN.has(n.id)).map(n => ({ id: `seq-${n.id}`, kind: "point" as const, nodeId: n.id }));
        const addE = edges.filter(e => !haveE.has(e.id)).map(e => ({ id: `seq-${e.id}`, kind: "process" as const, edgeId: e.id }));
  
        return [...filtered, ...addN, ...addE];
      });
    }, [nodes, edges]);
  
    const P = useMemo(
      () => pressureMode === "altitude" ? calcPressureFromAltitude(safeNum(altitude)) : safeNum(pressure, 101.325),
      [pressureMode, altitude, pressure]
    );
  
    const edgesFromSeq = useMemo(() => applySequenceToEdges(sequence, edges), [sequence, edges]);
    const { ptMap, segments } = useMemo(() => solveNetwork(nodes, edgesFromSeq, P, isIP), [nodes, edgesFromSeq, P, isIP]);
  
    // Save / Load
    const saveProject = () => {
      const project: SavedProject = {
        id: uid(),
        name: projectName,
        savedAt: new Date().toLocaleString(),
        pressureMode,
        altitude,
        pressure,
        nodes,
        edges,
        sequence,
      };
      const updated = [project, ...savedProjects];
      setSavedProjects(updated);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    };
  
    const loadProject = (id: string) => {
      const sp = savedProjects.find(p => p.id === id);
      if (!sp) return;
      setProjectName(sp.name);
      setPressureMode(sp.pressureMode);
      setAltitude(sp.altitude);
      setPressure(sp.pressure);
      setNodes(sp.nodes);
      setEdges(sp.edges);
      setSequence(sp.sequence ?? makeInitialSequence(sp.nodes, sp.edges));
      setShowProjects(false);
    };
  
    // Node ops
    const updateNode = (id: string, patch: Partial<PointNode>) =>
      setNodes(prev => prev.map(n => n.id === id ? { ...n, ...patch } : n));
  
    const addNode = () => {
      const id = uid();
      const nn: PointNode = {
        id,
        name: `Point ${nodes.length + 1}`,
        dbInput: 22,
        rhInput: 50,
        wbInput: 16,
        inputMode: "dbRh",
        flowInput: 1000,
        flowType: "volume",
        chartDx: 10,
        chartDy: -10,
      };
      setNodes(prev => [...prev, nn]);
      setSequence(prev => [...prev, { id: `seq-${id}`, kind: "point", nodeId: id }]);
    };
  
    const removeNode = (id: string) => {
      setNodes(prev => prev.filter(n => n.id !== id));
      setEdges(prev => prev.filter(e => e.sourceId !== id && e.targetId !== id && e.source2Id !== id));
      setSequence(prev => prev.filter(it => !(it.kind === "point" && it.nodeId === id)));
    };
  
    // Edge ops
    const updateEdge = (id: string, patch: Partial<ProcessEdge>) =>
      setEdges(prev => prev.map(e => e.id === id ? { ...e, ...patch } : e));
  
    const removeEdge = (id: string) => {
      setEdges(prev => prev.filter(e => e.id !== id));
      setSequence(prev => prev.filter(it => !(it.kind === "process" && it.edgeId === id)));
    };
  
    // ─────────────────────────────────────────────────────────────
    // Arrow move buttons for ANY card (point/process)
    // ─────────────────────────────────────────────────────────────
    const moveCardBySeqId = (seqId: string, dir: -1 | 1) => {
      setSequence(prev => {
        const i = prev.findIndex(s => s.id === seqId);
        if (i < 0) return prev;
        const j = i + dir;
        if (j < 0 || j >= prev.length) return prev;
        return arrayMove(prev, i, j);
      });
    };
  
    // ─────────────────────────────────────────────────────────────
    // Stable SWAP pointer drag (cards swap on enter)
    // ─────────────────────────────────────────────────────────────
    const itemRefs = useRef(new Map<string, HTMLDivElement | null>());
    const [dragId, setDragId] = useState<string | null>(null);
    const [ghost, setGhost] = useState<null | { x:number; y:number; w:number; h:number; ox:number; oy:number }>(null);
    const dragRafRef = useRef<number | null>(null);
    const lastOverIdRef = useRef<string | null>(null);
    const HYST_PX = 18;
  
    const registerItemRef = (id: string) => (el: HTMLDivElement | null) => itemRefs.current.set(id, el);
  
    const computeOverId = (clientX: number, clientY: number) => {
      let overId: string | null = null;
      itemRefs.current.forEach((el, id) => {
        if (!el || id === dragId) return;
        const r = el.getBoundingClientRect();
        if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) overId = id;
      });
      if (overId) return overId;
  
      let best: string | null = null;
      let bestD = Infinity;
      itemRefs.current.forEach((el, id) => {
        if (!el || id === dragId) return;
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const d = (cx - clientX) ** 2 + (cy - clientY) ** 2;
        if (d < bestD) { bestD = d; best = id; }
      });
      return best;
    };
  
    const startDrag = (seqId: string, e: React.PointerEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "button" || tag === "select" || tag === "textarea") return;
  
      const el = itemRefs.current.get(seqId);
      if (!el) return;
      const r = el.getBoundingClientRect();
  
      setDragId(seqId);
      lastOverIdRef.current = null;
      setGhost({ x:r.left, y:r.top, w:r.width, h:r.height, ox:e.clientX - r.left, oy:e.clientY - r.top });
  
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    };
  
    const onMoveDrag = (e: React.PointerEvent) => {
      if (!dragId || !ghost) return;
      if (dragRafRef.current) return;
  
      dragRafRef.current = requestAnimationFrame(() => {
        dragRafRef.current = null;
  
        setGhost(g => g ? ({ ...g, x: e.clientX - g.ox, y: e.clientY - g.oy }) : g);
  
        const overId = computeOverId(e.clientX, e.clientY);
        if (!overId || overId === dragId) { lastOverIdRef.current = null; return; }
  
        const overEl = itemRefs.current.get(overId);
        if (!overEl) return;
  
        const r = overEl.getBoundingClientRect();
        const midX = r.left + r.width / 2;
        const dx = e.clientX - midX;
        if (Math.abs(dx) < HYST_PX) return;
  
        if (lastOverIdRef.current === overId) return;
        lastOverIdRef.current = overId;
  
        setSequence(prev => {
          const from = prev.findIndex(s => s.id === dragId);
          const to = prev.findIndex(s => s.id === overId);
          if (from < 0 || to < 0 || from === to) return prev;
          const next = [...prev];
          [next[from], next[to]] = [next[to], next[from]];
          return next;
        });
      });
    };
  
    const endDrag = () => {
      if (dragRafRef.current) cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = null;
      lastOverIdRef.current = null;
      setDragId(null);
      setGhost(null);
    };
  
    // ─────────────────────────────────────────────────────────────
    // Drop palette processes BEFORE/AFTER/BETWEEN anywhere in chain
    // ─────────────────────────────────────────────────────────────
    const insertPaletteProcessAt = (processType: ProcessKind, insertIndex: number) => {
      const base = defaultProcess(processType);
      const newEdge: ProcessEdge = { id: uid(), ...base, sourceId: nodes[0]?.id || "", targetId: nodes[0]?.id || "" };
  
      setEdges(prev => [...prev, newEdge]);
      setSequence(prev => {
        const next = [...prev];
        const item: SequenceItem = { id: `seq-${newEdge.id}`, kind: "process", edgeId: newEdge.id };
        const i = Math.max(0, Math.min(insertIndex, next.length));
        next.splice(i, 0, item);
        return next;
      });
    };
  
    const getInsertIndexFromPointer = (clientX: number, clientY: number) => {
      if (sequence.length === 0) return 0;
  
      let bestId: string | null = null;
      let bestD = Infinity;
  
      for (const it of sequence) {
        const el = itemRefs.current.get(it.id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const d = (cx - clientX) ** 2 + (cy - clientY) ** 2;
        if (d < bestD) { bestD = d; bestId = it.id; }
      }
      if (!bestId) return sequence.length;
  
      const idx = sequence.findIndex(s => s.id === bestId);
      const el = itemRefs.current.get(bestId);
      if (!el) return sequence.length;
  
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
  
      const sameRow = Math.abs(clientY - cy) < r.height * 0.35;
      const after = sameRow ? (clientX > cx) : (clientY > cy);
  
      return after ? idx + 1 : idx;
    };
  
    const onChainDragOver = (e: React.DragEvent) => {
      const p = getDragData(e);
      if (p?.from === "palette") e.preventDefault(); // must preventDefault
    };
  
    const onChainDrop = (e: React.DragEvent) => {
      const p = getDragData(e);
      if (!p || p.from !== "palette") return;
      e.preventDefault();
      const insertIndex = getInsertIndexFromPointer(e.clientX, e.clientY);
      insertPaletteProcessAt(p.processType, insertIndex);
    };
  
// ─────────────────────────────────────────────────────────────
  // Chart (axes move with pan/zoom) + thicker lines + RH labels
  // ─────────────────────────────────────────────────────────────
  const chartWrapRef = useRef<HTMLDivElement | null>(null);
  const chartSvgRef = useRef<SVGSVGElement | null>(null);

  const [chartTransform, setChartTransform] = useState({ x: 0, y: 0, k: 1 });
  const [chartIsPanning, setChartIsPanning] = useState(false);
  const [chartPanStart, setChartPanStart] = useState({ x: 0, y: 0 });
  const [chartDragPointId, setChartDragPointId] = useState<string | null>(null);

  const dbTicks = useMemo(() => Array.from({ length: 13 }, (_, i) => CHART.minDb + i * 5), []);
  const wTicks = useMemo(() => Array.from({ length: 7 }, (_, i) => i * 0.005), []);

  const satPath = useMemo(() => {
    const pts: { x: number; y: number }[] = [];
    for (let db = CHART.minDb; db <= CHART.maxDb; db++) {
      pts.push({ x: xScale(db), y: yScale(Math.min(humidityRatio(db, 100, P), CHART.maxW)) });
    }
    return buildPath(pts);
  }, [P]);

  const rhCurves = useMemo(() => {
    const labelDb = 30; // where to place RH labels
    return [10, 20, 30, 40, 50, 60, 70, 80, 90].map((rh) => {
      const pts: { x: number; y: number }[] = [];
      for (let db = CHART.minDb; db <= CHART.maxDb; db++) {
        const W = humidityRatio(db, rh, P);
        if (W <= CHART.maxW) pts.push({ x: xScale(db), y: yScale(W) });
      }
      const Wlbl = humidityRatio(labelDb, rh, P);
      const label =
        Wlbl <= CHART.maxW
          ? { x: xScale(labelDb) + 6, y: yScale(Wlbl) - 4, text: `${rh}% RH` }
          : null;
      return { rh, path: buildPath(pts), label };
    });
  }, [P]);

  const wbCurves = useMemo(() => {
    return [-5, 0, 5, 10, 15, 20, 25, 30].map((wb) => {
      const sp = pointFromDbRh(wb, 100, P);
      const pts: { x: number; y: number }[] = [];
      for (let db = wb; db <= CHART.maxDb; db++) {
        const W = (sp.h - 1.006 * db) / (2501 + 1.86 * db);
        if (W >= 0 && W <= CHART.maxW && W <= humidityRatio(db, 100, P)) pts.push({ x: xScale(db), y: yScale(W) });
      }
      return { wb, path: buildPath(pts) };
    });
  }, [P]);

  const zoom = (dir: 1 | -1) => {
    const factor = dir === 1 ? 1.18 : 1 / 1.18;
    setChartTransform((t) => ({ ...t, k: clamp(t.k * factor, 0.6, 8) }));
  };
  const resetView = () => setChartTransform({ x: 0, y: 0, k: 1 });

  const screenToLocal = (clientX: number, clientY: number) => {
    if (!chartSvgRef.current) return null;
    const r = chartSvgRef.current.getBoundingClientRect();
    const sx = clientX - r.left;
    const sy = clientY - r.top;
    const lx = (sx - chartTransform.x) / chartTransform.k;
    const ly = (sy - chartTransform.y) / chartTransform.k;
    return { lx, ly };
  };

  const updateNodeFromDbW_SI = (nodeId: string, dbSI: number, W: number) => {
    const n = nodes.find((nn) => nn.id === nodeId);
    if (!n) return;

    const rh = rhFromW(dbSI, W, P);
    const wb = wetBulbFromDbRh(dbSI, rh, P);

    updateNode(nodeId, {
      dbInput: units.temp.toDisp(dbSI),
      ...(n.inputMode === "dbRh" ? { rhInput: rh } : { wbInput: units.temp.toDisp(wb) }),
    });
  };

  const onChartPointerDown = (e: React.PointerEvent) => {
    if (chartDragPointId) return;
    setChartIsPanning(true);
    setChartPanStart({ x: e.clientX - chartTransform.x, y: e.clientY - chartTransform.y });
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const onChartPointerMove = (e: React.PointerEvent) => {
    if (chartDragPointId) {
      const loc = screenToLocal(e.clientX, e.clientY);
      if (!loc) return;
      const db = clamp(xUnscale(loc.lx), CHART.minDb, CHART.maxDb);
      const W = clamp(yUnscale(loc.ly), CHART.minW, CHART.maxW);
      const Wsat = humidityRatio(db, 100, P);
      updateNodeFromDbW_SI(chartDragPointId, db, Math.min(W, Wsat));
      return;
    }
    if (!chartIsPanning) return;
    setChartTransform((t) => ({ ...t, x: e.clientX - chartPanStart.x, y: e.clientY - chartPanStart.y }));
  };

  const onChartPointerUp = () => {
    setChartIsPanning(false);
    setChartDragPointId(null);
  };

  // ─────────────────────────────────────────────────────────────
  // PDF export (chart image + tables) — similar to sample report layout
  // ─────────────────────────────────────────────────────────────
  const exportPdf = async () => {
    try {
      const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();

      // Header
      doc.setFont("helvetica", "bold");
      doc.setFontSize(16);
      doc.text("STATE POINT & PROCESS REPORT", 40, 40);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.text(`Project: ${projectName}`, 40, 58);
      doc.text(`Pressure: ${P.toFixed(3)} kPa`, 40, 72);

      // Capture chart
      if (!chartWrapRef.current) throw new Error("Chart container not found");
      const png = await toPng(chartWrapRef.current, { cacheBust: true, pixelRatio: 2 });

      // Chart image placement
      const imgX = 40;
      const imgY = 90;
      const imgW = pageW - 80;
      const imgH = Math.min(pageH - 140, (imgW * 9) / 16); // keep decent ratio
      doc.addImage(png, "PNG", imgX, imgY, imgW, imgH);

      // Page 2: tables
      doc.addPage();
      doc.setFont("helvetica", "bold");
      doc.setFontSize(14);
      doc.text("STATE POINT DATA", 40, 40);

      // Build point rows
      const pts = Array.from(ptMap.values());
      const startY = 60;
      let y = startY;

      doc.setFontSize(10);
      doc.setFont("helvetica", "bold");
      doc.text("Name", 40, y);
      doc.text("Flow (L/s)", 150, y);
      doc.text("DB", 240, y);
      doc.text("WB", 290, y);
      doc.text("RH", 340, y);
      doc.text("W (g/kg)", 390, y);
      doc.text("h", 460, y);
      doc.text("DP", 520, y);
      y += 14;
      doc.setFont("helvetica", "normal");

      const toLs = (m3h: number) => (m3h * 1000) / 3600;

      for (const p of pts) {
        if (y > pageH - 80) { doc.addPage(); y = 40; }
        doc.text(p.nodeRef.name, 40, y);
        doc.text(toLs(p.vol).toFixed(1), 150, y);
        doc.text(p.db.toFixed(1), 240, y);
        doc.text(p.wb.toFixed(1), 290, y);
        doc.text(p.rh.toFixed(1), 340, y);
        doc.text((p.W * 1000).toFixed(2), 390, y);
        doc.text(p.h.toFixed(1), 460, y);
        doc.text(p.dp.toFixed(1), 520, y);
        y += 14;
      }

      // Process table
      y += 14;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(14);
      doc.text("PROCESS SUMMARY", 40, y);
      y += 18;

      doc.setFontSize(10);
      doc.setFont("helvetica", "bold");
      doc.text("Process", 40, y);
      doc.text("From → To", 180, y);
      doc.text("Total kW", 330, y);
      doc.text("Sens kW", 410, y);
      doc.text("Lat kW", 480, y);
      doc.text("Moist kg/h", 550, y);
      y += 14;
      doc.setFont("helvetica", "normal");

      for (const s of segments) {
        if (y > pageH - 60) { doc.addPage(); y = 40; }
        doc.text(s.edge.name, 40, y);
        doc.text(`${s.from.nodeRef.name} → ${s.to.nodeRef.name}`, 180, y);
        doc.text(s.totalKW.toFixed(2), 330, y);
        doc.text(s.sensKW.toFixed(2), 410, y);
        doc.text(s.latKW.toFixed(2), 480, y);
        doc.text(s.moistureKgHr.toFixed(2), 550, y);
        y += 14;
      }

      doc.save(`${projectName.replace(/[^\w\-]+/g, "_")}_Psychrometric_Report.pdf`);
    } catch (err: any) {
      alert(`PDF export failed: ${err?.message || err}`);
    }
  };

    // ─── Render ────────────────────────────────────────────────────────────────
    return (
      <div style={{
        minHeight: "100vh", padding: 18, fontFamily: "system-ui, sans-serif",
        background: "#f8fafc", boxSizing: "border-box", maxWidth: 1400, margin: "0 auto"
      }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <HeroShieldIcon />
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 950, color: "#0f172a" }}>Mechanical IL Psychrometric</h1>
          </div>
  
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <div style={{ background: "#e2e8f0", padding: 4, borderRadius: 10, display: "flex", gap: 4 }}>
              <button onClick={() => setIsIP(false)} style={css.btn(!isIP, "blue")}>SI Units</button>
              <button onClick={() => setIsIP(true)} style={css.btn(isIP, "blue")}>IP Units</button>
            </div>
            <input value={projectName} onChange={(e) => setProjectName(e.target.value)}
              style={{ padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 10, fontSize: 13 }} />
            <button onClick={saveProject} style={css.btn(true, "blue")}>Save</button>
            <button onClick={() => setShowProjects(v => !v)} style={css.btn(showProjects, "outline")}>Database</button>
          </div>
        </div>
  
        {showProjects && (
          <div style={{ ...css.panel, background: "#f0f9ff" }}>
            <h3 style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 950 }}>Saved Projects</h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {savedProjects.map(sp => (
                <div key={sp.id} style={{ ...css.card, background: "#fff", width: 260 }}>
                  <div style={{ fontWeight: 950 }}>{sp.name}</div>
                  <div style={{ fontSize: 11, color: "#6b7280", margin: "4px 0 10px" }}>{sp.savedAt}</div>
                  <button onClick={() => loadProject(sp.id)} style={css.btn(true, "blue")}>Load</button>
                </div>
              ))}
            </div>
          </div>
        )}
  
        {/* Environmental Parameters */}
        <div style={css.panel}>
          <h2 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 950 }}>Environmental Parameters</h2>
          <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
            <button onClick={() => setPressureMode("altitude")} style={css.btn(pressureMode === "altitude", "gray")}>Set via Altitude</button>
            <button onClick={() => setPressureMode("pressure")} style={css.btn(pressureMode === "pressure", "gray")}>Set via Pressure</button>
          </div>
          <div style={{ width: 240 }}>
            {pressureMode === "altitude"
              ? <UnitField label="Site Elevation" val={altitude} setVal={setAltitude} conv={units.alt} />
              : <UnitField label="Absolute Pressure" val={pressure} setVal={setPressure} conv={units.pres} />}
          </div>
        </div>
  
        {/* Points Parameters */}
        <div style={css.panel}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 950 }}>Points Parameters</h2>
            <button onClick={addNode} style={css.btn(false, "blue")}>+ Add State Point</button>
          </div>
  
          {/* Processes palette */}
          <div style={{ ...css.card, background: "#fff", marginBottom: 12 }}>
            <div style={{ fontWeight: 950, marginBottom: 8 }}>Processes (drag into chain)</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {PROCESS_PALETTE.map(p => (
                <div
                  key={p.type}
                  draggable
                  onDragStart={(e) => setDragData(e, { from: "palette", processType: p.type })}
                  title={p.hint}
                  style={{
                    width: 190, padding: "10px 10px", borderRadius: 12, cursor: "grab",
                    border: `1px solid ${p.color}55`, background: `${p.color}12`,
                    display: "flex", gap: 10, alignItems: "center", userSelect: "none"
                  }}
                >
                  <div style={{
                    width: 34, height: 34, borderRadius: 10,
                    background: `${p.color}25`, border: `1px solid ${p.color}55`,
                    display: "grid", placeItems: "center",
                    fontSize: 18, fontWeight: 950, color: p.color
                  }}>{p.symbol}</div>
                  <div style={{ lineHeight: 1.1 }}>
                    <div style={{ fontWeight: 950, fontSize: 13 }}>{p.label}</div>
                    <div style={{ fontSize: 11, color: "#64748b" }}>{p.hint}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
  
          {/* Chain area (drop target) */}
          <div
            style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-start", position: "relative" }}
            onDragOver={onChainDragOver}
            onDrop={onChainDrop}
          >
            {sequence.map((it) => {
              const idx = sequence.findIndex(s => s.id === it.id);
              const arrowBar = (
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => moveCardBySeqId(it.id, -1)} disabled={idx === 0} style={css.btn(false, "outline")} title="Move earlier">←</button>
                  <button onClick={() => moveCardBySeqId(it.id, 1)} disabled={idx === sequence.length - 1} style={css.btn(false, "outline")} title="Move later">→</button>
                </div>
              );
  
              if (it.kind === "point") {
                const n = nodes.find(x => x.id === it.nodeId);
                if (!n) return null;
  
                const solved = ptMap.get(n.id);
                const isCalc = !!solved?.isCalculated;
  
                const dbSI = units.temp.toSI(n.dbInput);
                const preview = n.inputMode === "dbWb"
                  ? pointFromDbWb(dbSI, units.temp.toSI(n.wbInput), P)
                  : pointFromDbRh(dbSI, n.rhInput, P);
  
                const showDB = isCalc && solved ? solved.db : preview.db;
                const showRH = isCalc && solved ? solved.rh : preview.rh;
                const showWB = isCalc && solved ? solved.wb : preview.wb;
                const showH  = isCalc && solved ? solved.h  : preview.h;
  
                return (
                  <div
                    key={it.id}
                    ref={registerItemRef(it.id)}
                    onPointerDown={(e) => startDrag(it.id, e)}
                    onPointerMove={onMoveDrag}
                    onPointerUp={endDrag}
                    style={{
                      ...css.card, width: 320, padding: 12, background: "#fff",
                      borderLeft: `4px solid ${isCalc ? "#059669" : "#2563eb"}`,
                      cursor: dragId ? "grabbing" : "grab",
                      opacity: dragId === it.id ? 0.25 : 1,
                      userSelect: "none"
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
                      <div style={{ flex: 1 }}>
                        <input
                          value={n.name}
                          onChange={(e) => updateNode(n.id, { name: e.target.value })}
                          style={{ width: "100%", fontWeight: 900, border: "none", background: "transparent", fontSize: 13, borderBottom: "1px solid #cbd5e1", outline: "none" }}
                        />
                      </div>
                      {arrowBar}
                      <button onClick={() => removeNode(n.id)} style={css.btn(false, "red")} title="Delete point">✕</button>
                    </div>
  
                    <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                      <button disabled={isCalc} onClick={() => updateNode(n.id, { inputMode: "dbRh" })} style={css.btn(n.inputMode === "dbRh", "gray")}>DB + RH</button>
                      <button disabled={isCalc} onClick={() => updateNode(n.id, { inputMode: "dbWb" })} style={css.btn(n.inputMode === "dbWb", "gray")}>DB + WB</button>
                    </div>
  
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <UnitField label="Dry Bulb" val={units.temp.toDisp(showDB)} setVal={(v) => updateNode(n.id, { dbInput: v })} conv={units.temp} disabled={isCalc} />
                      {n.inputMode === "dbRh" ? (
                        <UnitField label="Relative Humidity" val={showRH} setVal={(v) => updateNode(n.id, { rhInput: v })} conv={{ toDisp: x => x, toSI: x => x, u: "%" }} disabled={isCalc} />
                      ) : (
                        <UnitField label="Wet Bulb" val={units.temp.toDisp(showWB)} setVal={(v) => updateNode(n.id, { wbInput: v })} conv={units.temp} disabled={isCalc} />
                      )}
                    </div>
  
                    <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <span title="Dry Bulb Temperature" style={pillStyle()}>DB: <b>{units.temp.toDisp(showDB).toFixed(1)}{units.temp.u}</b></span>
                      <span title="Wet Bulb Temperature" style={pillStyle()}>WB: <b>{units.temp.toDisp(showWB).toFixed(1)}{units.temp.u}</b></span>
                      <span title="Relative Humidity" style={pillStyle()}>RH: <b>{showRH.toFixed(1)}%</b></span>
                      <span title="Enthalpy" style={pillStyle()}>h: <b>{units.enth.toDisp(showH).toFixed(1)} {units.enth.u}</b></span>
                    </div>
  
                    <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "flex-end" }}>
                      <div style={{ flex: 1 }}>
                        <UnitField
                          label={n.flowType === "mass" ? "Mass Flow" : "Volumetric Flow"}
                          val={n.flowInput}
                          setVal={(v) => updateNode(n.id, { flowInput: v })}
                          conv={n.flowType === "mass" ? units.mda : units.vol}
                          disabled={isCalc}
                        />
                      </div>
                      <button
                        disabled={isCalc}
                        onClick={() => updateNode(n.id, { flowType: n.flowType === "mass" ? "volume" : "mass" })}
                        style={{ ...css.btn(false, "outline"), height: 36 }}
                      >
                        Swap
                      </button>
                    </div>
                  </div>
                );
              }
  
              // process card
              const e = edges.find(x => x.id === it.edgeId);
              if (!e) return null;
  
              return (
                <div
                  key={it.id}
                  ref={registerItemRef(it.id)}
                  onPointerDown={(ev) => startDrag(it.id, ev)}
                  onPointerMove={onMoveDrag}
                  onPointerUp={endDrag}
                  style={{
                    ...css.card, width: 320, padding: 12, background: "#fff",
                    borderLeft: "4px solid #7c3aed",
                    cursor: dragId ? "grabbing" : "grab",
                    opacity: dragId === it.id ? 0.25 : 1,
                    userSelect: "none"
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
                    <div style={{ flex: 1 }}>
                      <input
                        value={e.name}
                        onChange={(ev) => updateEdge(e.id, { name: ev.target.value })}
                        style={{ width: "100%", fontWeight: 950, border: "none", background: "transparent", fontSize: 13, borderBottom: "1px solid #cbd5e1" }}
                      />
                    </div>
                    {arrowBar}
                    <button onClick={() => removeEdge(e.id)} style={css.btn(false, "red")} title="Delete process">Del</button>
                  </div>
  
                  <div style={{ fontSize: 12, color: "#64748b", marginBottom: 8 }}>
                    Type: <b style={{ color: "#0f172a" }}>{e.type}</b>
                  </div>
  
                  {e.type === "mixing" && (
                    <div>
                      <label style={{ fontSize: 12, fontWeight: 900, color: "#475569", display: "block", marginBottom: 4 }}>Second Stream</label>
                      <select
                        value={e.source2Id || ""}
                        onChange={(ev) => updateEdge(e.id, { source2Id: ev.target.value })}
                        style={{ width: "100%", padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 10, fontSize: 13 }}
                      >
                        <option value="">Select stream 2...</option>
                        {nodes.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}
                      </select>
                    </div>
                  )}
  
                  {(e.type === "sensibleCooling" || e.type === "heating") && (
                    <div style={{ marginTop: 8 }}>
                      <UnitField label="Leaving DB" val={e.leavingDbInput || 0} setVal={(v) => updateEdge(e.id, { leavingDbInput: v })} conv={units.temp} />
                    </div>
                  )}
  
                  {e.type === "cooling" && (
                    <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <UnitField label="ADP" val={e.adpInput || 0} setVal={(v) => updateEdge(e.id, { adpInput: v })} conv={units.temp} />
                      <UnitField label="BF" val={e.bfInput || 0.1} setVal={(v) => updateEdge(e.id, { bfInput: v })} step={0.01} />
                    </div>
                  )}
  
                  {e.type === "humidifying" && (
                    <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <select
                        value={e.humidifierMode || "steam"}
                        onChange={(ev) => updateEdge(e.id, { humidifierMode: ev.target.value as any })}
                        style={{ padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 10, fontSize: 13, background: "#fff" }}
                      >
                        <option value="steam">Steam</option>
                        <option value="evaporative">Evaporative</option>
                      </select>
                      <UnitField label="Moisture Added" val={e.moistureInput || 0} setVal={(v) => updateEdge(e.id, { moistureInput: v })} conv={units.mda} />
                    </div>
                  )}
  
                  {e.type === "dehumidifying" && (
                    <div style={{ marginTop: 8 }}>
                      <UnitField label="Moisture Removed" val={e.moistureInput || 0} setVal={(v) => updateEdge(e.id, { moistureInput: v })} conv={units.mda} />
                    </div>
                  )}
                </div>
              );
            })}
  
            {ghost && (
              <div
                style={{
                  position: "fixed",
                  left: ghost.x,
                  top: ghost.y,
                  width: ghost.w,
                  height: ghost.h,
                  pointerEvents: "none",
                  zIndex: 9999,
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.88)",
                  border: "1px solid rgba(148,163,184,0.6)",
                  boxShadow: "0 14px 34px rgba(0,0,0,0.20)",
                }}
              />
            )}
          </div>
        </div>
  
        {/* Chart + PDF export come in Part 4 */}
{/* Chart */}
<div style={css.panel}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 950 }}>Chart</h2>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => zoom(1)} style={css.btn(false, "outline")}>+</button>
            <button onClick={() => zoom(-1)} style={css.btn(false, "outline")}>−</button>
            <button onClick={resetView} style={css.btn(false, "outline")}>Reset</button>
            <button onClick={exportPdf} style={css.btn(true, "blue")}>Export PDF</button>
          </div>
        </div>

        {/* IMPORTANT: wrap ref is used for PDF capture */}
        <div ref={chartWrapRef} style={{ border: "1px solid #e2e8f0", borderRadius: 10, background: "#fff", overflow: "hidden" }}>
          <svg
            ref={chartSvgRef}
            width={CHART.width}
            height={CHART.height}
            onPointerDown={onChartPointerDown}
            onPointerMove={onChartPointerMove}
            onPointerUp={onChartPointerUp}
            style={{ cursor: chartDragPointId ? "grabbing" : chartIsPanning ? "grabbing" : "grab", touchAction: "none" }}
          >
            <defs>
              {/* clip whole SVG so axes can move too (fix #3) */}
              <clipPath id="chart-all">
                <rect x={0} y={0} width={CHART.width} height={CHART.height} />
              </clipPath>

              <marker id="arrowSmall" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                <path d="M0,0 L0,6 L6,3 z" fill="#111827" />
              </marker>
            </defs>

            {/* EVERYTHING is inside the transformed group (axes move with chart) */}
            <g transform={`translate(${chartTransform.x}, ${chartTransform.y}) scale(${chartTransform.k})`} clipPath="url(#chart-all)">

              {/* Axes ticks (move with chart) */}
              {dbTicks.map((db) => (
                <text key={`dbtick-${db}`} x={xScale(db)} y={CHART.height - 14} textAnchor="middle"
                      fontSize={12 / chartTransform.k} fill="#64748b">
                  {units.temp.toDisp(db).toFixed(0)}
                </text>
              ))}
              <text x={CHART.width / 2} y={CHART.height - 2} textAnchor="middle"
                    fontSize={13 / chartTransform.k} fill="#334155" fontWeight={900}>
                Dry Bulb ({units.temp.u})
              </text>

              {wTicks.map((W) => (
                <text key={`wtick-${W}`} x={CHART.marginLeft - 10} y={yScale(W) + 4} textAnchor="end"
                      fontSize={12 / chartTransform.k} fill="#64748b">
                  {units.w.toDisp(W).toFixed(units.w.u === "gr/lb" ? 0 : 3)}
                </text>
              ))}
              <text x={18} y={CHART.height / 2} textAnchor="middle"
                    fontSize={13 / chartTransform.k} fill="#334155" fontWeight={900}
                    transform={`rotate(-90, 18, ${CHART.height / 2})`}>
                Humidity Ratio ({units.w.u})
              </text>

              {wTicks.map((W) => {
                const dpSI = dewPointFromW(W, P);
                return (
                  <text key={`dptick-${W}`} x={CHART.width - CHART.marginRight + 10} y={yScale(W) + 4} textAnchor="start"
                        fontSize={12 / chartTransform.k} fill="#64748b">
                    {units.temp.toDisp(dpSI).toFixed(0)}
                  </text>
                );
              })}
              <text x={CHART.width - 18} y={CHART.height / 2} textAnchor="middle"
                    fontSize={13 / chartTransform.k} fill="#334155" fontWeight={900}
                    transform={`rotate(-90, ${CHART.width - 18}, ${CHART.height / 2})`}>
                Dew Point ({units.temp.u})
              </text>

              {/* Grid (thicker - fix #4) */}
              {dbTicks.map((db) => (
                <line key={`gx-${db}`} x1={xScale(db)} y1={yScale(CHART.minW)} x2={xScale(db)} y2={yScale(CHART.maxW)}
                      stroke="#e5e7eb" strokeWidth={2.0 / chartTransform.k} />
              ))}
              {wTicks.map((W) => (
                <line key={`gy-${W}`} x1={xScale(CHART.minDb)} y1={yScale(W)} x2={xScale(CHART.maxDb)} y2={yScale(W)}
                      stroke="#e5e7eb" strokeWidth={2.0 / chartTransform.k} />
              ))}

              {/* RH curves + RH labels (fix #5) */}
              {rhCurves.map((c) => (
                <g key={`rh-${c.rh}`}>
                  <path d={c.path} fill="none" stroke="#94a3b8" strokeDasharray="6 5" strokeWidth={2.2 / chartTransform.k} />
                  {c.label && (
                    <text x={c.label.x} y={c.label.y} fontSize={12 / chartTransform.k} fill="#64748b" fontWeight={900}>
                      {c.label.text}
                    </text>
                  )}
                </g>
              ))}

              {/* WB curves */}
              {wbCurves.map((c) => (
                <path key={`wb-${c.wb}`} d={c.path} fill="none" stroke="#34d399" strokeDasharray="3 7" strokeWidth={2.2 / chartTransform.k} />
              ))}

              {/* Saturation curve */}
              <path d={satPath} fill="none" stroke="#2563eb" strokeWidth={4.0 / chartTransform.k} />

              {/* Process lines (thicker) */}
              {segments.map((s) => (
                <line key={`seg-${s.id}`}
                      x1={xScale(s.from.db)} y1={yScale(s.from.W)}
                      x2={xScale(s.to.db)}   y2={yScale(s.to.W)}
                      stroke="#111827" strokeWidth={4.2 / chartTransform.k} markerEnd="url(#arrowSmall)" />
              ))}

              {/* Draggable points */}
              {Array.from(ptMap.values()).map((pt, i) => {
                const col = POINT_COLORS[i % POINT_COLORS.length];
                const x = xScale(pt.db);
                const y = yScale(pt.W);
                return (
                  <g key={`pt-${pt.nodeRef.id}`}>
                    <circle
                      cx={x} cy={y} r={9 / chartTransform.k}
                      fill={col} stroke="#fff" strokeWidth={2.2 / chartTransform.k}
                      style={{ cursor: "grab" }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        setChartDragPointId(pt.nodeRef.id);
                        (e.target as Element).setPointerCapture(e.pointerId);
                      }}
                    />
                    <text
                      x={x + safeNum(pt.nodeRef.chartDx, 10) / chartTransform.k}
                      y={y + safeNum(pt.nodeRef.chartDy, -10) / chartTransform.k}
                      fontSize={13 / chartTransform.k}
                      fill={col}
                      fontWeight={950}
                    >
                      {pt.nodeRef.name}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        </div>
      </div>

      {/* Results */}
      <div style={css.panel}>
        <h2 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 950 }}>Results</h2>

        {segments.map((seg) => (
          <div key={`res-${seg.id}`} style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 12, marginBottom: 10, background: "#fff" }}>
            <div style={{ fontWeight: 950, fontSize: 14, marginBottom: 8 }}>
              {seg.edge.name}{" "}
              <span style={{ fontWeight: 700, color: "#64748b" }}>
                ({seg.from.nodeRef.name} → {seg.to.nodeRef.name})
              </span>
            </div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
              <div><span style={{ color: "#6b7280" }}>Total:</span> <b>{units.load.toDisp(safeNum(seg.totalKW)).toFixed(2)} {units.load.u}</b></div>
              <div><span style={{ color: "#6b7280" }}>Sensible:</span> <b>{units.load.toDisp(safeNum(seg.sensKW)).toFixed(2)} {units.load.u}</b></div>
              <div><span style={{ color: "#6b7280" }}>Latent:</span> <b>{units.load.toDisp(safeNum(seg.latKW)).toFixed(2)} {units.load.u}</b></div>
              <div><span style={{ color: "#6b7280" }}>SHR:</span> <b>{safeNum(seg.shr).toFixed(3)}</b></div>
              <div><span style={{ color: "#6b7280" }}>Moisture:</span> <b>{units.mda.toDisp(safeNum(seg.moistureKgHr)).toFixed(2)} {units.mda.u}</b></div>
            </div>
          </div>
        ))}

        {segments.length === 0 && <div style={{ color: "#9ca3af", fontSize: 13 }}>No calculated edges.</div>}
      </div>
      </div>
    );
  }