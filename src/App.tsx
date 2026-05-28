
import { useMemo, useState } from "react";

type Point = {
  db: number;
  rh: number;
  wb: number;
  dp: number;
  W: number;
  h: number;
  P: number;
};

const CHART = {
  width: 800,
  height: 420,
  marginLeft: 70,
  marginRight: 40,
  marginTop: 30,
  marginBottom: 70,
  minDb: -10,
  maxDb: 50,
  minW: 0,
  maxW: 0.030,
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export default function App() {
  // =========================
  // Base state (Point 1)
  // =========================
  const [db1, setDb1] = useState(30);
  const [rh1, setRh1] = useState(50);
  const [alt, setAlt] = useState(0);

  // =========================
  // Process selection
  // =========================
  const [mode, setMode] = useState<"sensible" | "condition" | "mixing">("sensible");

  // Flow of point 1 (dry-air basis)
  const [mda1, setMda1] = useState(10000); // kg dry air / hr

  // -------------------------
  // Sensible heating/cooling
  // -------------------------
  const [db2Sensible, setDb2Sensible] = useState(18);

  // -------------------------
  // Generic conditioning
  // -------------------------
  const [db2Cond, setDb2Cond] = useState(14);
  const [rh2Cond, setRh2Cond] = useState(90);

  // -------------------------
  // Mixing mode (Point 3 source)
  // -------------------------
  const [db3, setDb3] = useState(24);
  const [rh3, setRh3] = useState(40);
  const [mda3, setMda3] = useState(5000);

  // =========================
  // Report and ordering
  // =========================
  const [showReport, setShowReport] = useState(false);

  // =========================================================
  // Psychrometric helper functions
  // =========================================================

  // Pressure from altitude [kPa]
  function calcPressure(altitudeM: number) {
    return 101.325 * Math.pow(1 - 2.25577e-5 * altitudeM, 5.2559);
  }

  // Saturation vapor pressure [kPa]
  function satPressure(T: number) {
    return 0.61078 * Math.exp((17.27 * T) / (T + 237.3));
  }

  // Humidity ratio [kg/kg dry air]
  function humidityRatioFromDbRh(db: number, rh: number, P: number) {
    const Pw = satPressure(db) * (rh / 100);
    return 0.62198 * Pw / (P - Pw);
  }

  // Enthalpy [kJ/kg dry air]
  function enthalpy(db: number, W: number) {
    return 1.005 * db + W * (2501 + 1.86 * db);
  }

  // Dew point [°C]
  function dewPoint(db: number, rh: number) {
    const a = 17.27;
    const b = 237.7;
    const alpha = (a * db) / (b + db) + Math.log(rh / 100);
    return (b * alpha) / (a - alpha);
  }

  // Approx wet bulb [°C]
  function wetBulbApprox(db: number, rh: number) {
    return (
      db * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
      Math.atan(db + rh) -
      Math.atan(rh - 1.676331) +
      0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) -
      4.686035
    );
  }

  // RH from DB + W + P
  function rhFromDbW(db: number, W: number, P: number) {
    const Pw = (P * W) / (0.62198 + W);
    const Pws = satPressure(db);
    return (Pw / Pws) * 100;
  }

  // DB from h + W
  function dbFromHW(h: number, W: number) {
    return (h - 2501 * W) / (1.005 + 1.86 * W);
  }

  function makePointFromDbRh(db: number, rh: number, P: number): Point {
    const W = humidityRatioFromDbRh(db, rh, P);
    const h = enthalpy(db, W);
    const dp = dewPoint(db, rh);
    const wb = wetBulbApprox(db, rh);
    return { db, rh, wb, dp, W, h, P };
  }

  function makePointFromDbW(db: number, W: number, P: number): Point {
    const rh = rhFromDbW(db, W, P);
    const rhSafe = clamp(rh, 0.1, 100);
    const h = enthalpy(db, W);
    const dp = dewPoint(db, rhSafe);
    const wb = wetBulbApprox(db, rhSafe);
    return { db, rh: rhSafe, wb, dp, W, h, P };
  }

  // =========================================================
  // Point 1
  // =========================================================
  const P = useMemo(() => calcPressure(alt), [alt]);
  const p1 = useMemo(() => makePointFromDbRh(db1, rh1, P), [db1, rh1, P]);

  // =========================================================
  // Process calculation
  // =========================================================
  const result = useMemo(() => {
    let p2: Point;
    let label = "";
    let totalKW = 0;
    let sensibleKW = 0;
    let latentKW = 0;
    let p3: Point | undefined = undefined;

    if (mode === "sensible") {
      p2 = makePointFromDbW(db2Sensible, p1.W, P);
      label = db2Sensible >= p1.db ? "Sensible Heating" : "Sensible Cooling";

      totalKW = (mda1 * (p2.h - p1.h)) / 3600;
      sensibleKW = totalKW;
      latentKW = 0;
    } else if (mode === "condition") {
      p2 = makePointFromDbRh(db2Cond, rh2Cond, P);
      label =
        p2.db < p1.db
          ? "Cooling / Dehumidification or Cooling Process"
          : "Heating / Humidification or Heating Process";

      totalKW = (mda1 * (p2.h - p1.h)) / 3600;

      const Wavg = (p1.W + p2.W) / 2;
      sensibleKW = (mda1 * (1.005 + 1.86 * Wavg) * (p2.db - p1.db)) / 3600;
      latentKW = totalKW - sensibleKW;
    } else {
      p3 = makePointFromDbRh(db3, rh3, P);

      const mTotal = mda1 + mda3;
      const Wmix = (mda1 * p1.W + mda3 * p3.W) / mTotal;
      const hMix = (mda1 * p1.h + mda3 * p3.h) / mTotal;
      const dbMix = dbFromHW(hMix, Wmix);

      p2 = makePointFromDbW(dbMix, Wmix, P);
      label = "Adiabatic Mixing";

      totalKW = 0;
      sensibleKW = 0;
      latentKW = 0;
    }

    return {
      label,
      p2,
      p3,
      totalKW,
      sensibleKW,
      latentKW,
      moistureKgHr: mode === "mixing" ? 0 : mda1 * (p2.W - p1.W),
    };
  }, [mode, p1, P, db2Sensible, db2Cond, rh2Cond, mda1, db3, rh3, mda3]);

  // =========================================================
  // Chart helpers
  // =========================================================
  function xScale(db: number) {
    const { minDb, maxDb, width, marginLeft, marginRight } = CHART;
    const inner = width - marginLeft - marginRight;
    return marginLeft + ((db - minDb) / (maxDb - minDb)) * inner;
  }

  function yScale(W: number) {
    const { minW, maxW, height, marginTop, marginBottom } = CHART;
    const inner = height - marginTop - marginBottom;
    return height - marginBottom - ((W - minW) / (maxW - minW)) * inner;
  }

  function buildCurvePath(points: { x: number; y: number }[]) {
    return points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
      .join(" ");
  }

  const saturationPath = useMemo(() => {
    const pts: { x: number; y: number }[] = [];
    for (let db = CHART.minDb; db <= CHART.maxDb; db += 1) {
      const W = humidityRatioFromDbRh(db, 100, P);
      pts.push({ x: xScale(db), y: yScale(Math.min(W, CHART.maxW)) });
    }
    return buildCurvePath(pts);
  }, [P]);

  const rhCurves = useMemo(() => {
    const rhs = [10, 20, 30, 40, 50, 60, 70, 80, 90];
    return rhs.map((rh) => {
      const pts: { x: number; y: number }[] = [];
      for (let db = CHART.minDb; db <= CHART.maxDb; db += 1) {
        const W = humidityRatioFromDbRh(db, rh, P);
        if (W <= CHART.maxW) {
          pts.push({ x: xScale(db), y: yScale(W) });
        }
      }
      return { rh, path: buildCurvePath(pts) };
    });
  }, [P]);

  const chartPoints = useMemo(() => {
    const pts = [
      { id: "1", label: "P1", point: p1, color: "#2563eb" },
      { id: "2", label: "P2", point: result.p2, color: "#dc2626" },
    ];

    if (result.p3) {
      pts.push({ id: "3", label: "P3", point: result.p3, color: "#059669" });
    }

    return pts;
  }, [p1, result]);

  const processLines = useMemo(() => {
    const lines = [];
    if (result.p3 && mode === "mixing") {
      lines.push({
        id: "mix-1-3",
        x1: xScale(p1.db),
        y1: yScale(p1.W),
        x2: xScale(result.p3.db),
        y2: yScale(result.p3.W),
        color: "#7c3aed",
        dash: "6 6",
      });
    }

    lines.push({
      id: "process-1-2",
      x1: xScale(p1.db),
      y1: yScale(p1.W),
      x2: xScale(result.p2.db),
      y2: yScale(result.p2.W),
      color: "#111827",
      dash: "0",
    });

    return lines;
  }, [p1, result, mode]);

  function numInput(value: number, setValue: (n: number) => void, step = 1) {
    return (
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => setValue(Number(e.target.value))}
        style={{ width: 120, padding: 4 }}
      />
    );
  }

  return (
    <div style={{ padding: 20, fontFamily: "Arial, sans-serif", maxWidth: 1100 }}>
      <h2>Psychrometric Tool – Chart Version</h2>
      <p>
        State-point calculator + process solver + simple interactive psychrometric chart.
      </p>

      <hr />

      <h3>1) Enter Point 1</h3>
      <div style={{ display: "grid", gridTemplateColumns: "220px 200px", rowGap: 10, columnGap: 10 }}>
        <label>Dry Bulb 1 (°C)</label>
        {numInput(db1, setDb1, 0.1)}

        <label>RH 1 (%)</label>
        {numInput(rh1, setRh1, 0.1)}

        <label>Altitude (m)</label>
        {numInput(alt, setAlt, 1)}

        <label>Dry Air Mass Flow 1 (kg/h)</label>
        {numInput(mda1, setMda1, 1)}
      </div>

      <h4>Point 1 Results</h4>
      <ul>
        <li>Pressure: {p1.P.toFixed(2)} kPa</li>
        <li>Humidity Ratio: {p1.W.toFixed(4)} kg/kg dry air</li>
        <li>Enthalpy: {p1.h.toFixed(2)} kJ/kg dry air</li>
        <li>Dew Point: {p1.dp.toFixed(2)} °C</li>
        <li>Wet Bulb (approx): {p1.wb.toFixed(2)} °C</li>
      </ul>

      <hr />

      <h3>2) Select Process</h3>
      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <button onClick={() => setMode("sensible")}>Sensible</button>
        <button onClick={() => setMode("condition")}>Generic Conditioning</button>
        <button onClick={() => setMode("mixing")}>Mixing</button>
      </div>

      {mode === "sensible" && (
        <div style={{ marginBottom: 20 }}>
          <h4>Sensible Heating / Cooling</h4>
          <div style={{ display: "grid", gridTemplateColumns: "220px 200px", rowGap: 10, columnGap: 10 }}>
            <label>Leaving Dry Bulb 2 (°C)</label>
            {numInput(db2Sensible, setDb2Sensible, 0.1)}
          </div>
          <p style={{ color: "#555" }}>
            Assumption: humidity ratio remains constant.
          </p>
        </div>
      )}

      {mode === "condition" && (
        <div style={{ marginBottom: 20 }}>
          <h4>Generic State-to-State Conditioning</h4>
          <div style={{ display: "grid", gridTemplateColumns: "220px 200px", rowGap: 10, columnGap: 10 }}>
            <label>Leaving Dry Bulb 2 (°C)</label>
            {numInput(db2Cond, setDb2Cond, 0.1)}

            <label>Leaving RH 2 (%)</label>
            {numInput(rh2Cond, setRh2Cond, 0.1)}
          </div>
          <p style={{ color: "#555" }}>
            Useful for process studies. Not yet a true coil-line / bypass-factor solver.
          </p>
        </div>
      )}

      {mode === "mixing" && (
        <div style={{ marginBottom: 20 }}>
          <h4>Mixing Stream 1 + Stream 2</h4>
          <div style={{ display: "grid", gridTemplateColumns: "220px 200px", rowGap: 10, columnGap: 10 }}>
            <label>Dry Bulb 2nd Stream (°C)</label>
            {numInput(db3, setDb3, 0.1)}

            <label>RH 2nd Stream (%)</label>
            {numInput(rh3, setRh3, 0.1)}

            <label>Dry Air Mass Flow 2nd Stream (kg/h)</label>
            {numInput(mda3, setMda3, 1)}
          </div>
          <p style={{ color: "#555" }}>
            Mixing is done on dry-air mass basis using weighted W and h.
          </p>
        </div>
      )}

      <hr />

      <h3>3) Chart</h3>
      <div style={{ overflowX: "auto", border: "1px solid #ddd", padding: 10, marginBottom: 20 }}>
        <svg width={CHART.width} height={CHART.height} style={{ background: "white" }}>
          {/* Grid: vertical DB lines */}
          {Array.from({ length: 13 }).map((_, i) => {
            const db = CHART.minDb + i * 5;
            const x = xScale(db);
            return (
              <g key={`v-${db}`}>
                <line
                  x1={x}
                  y1={yScale(CHART.minW)}
                  x2={x}
                  y2={yScale(CHART.maxW)}
                  stroke="#e5e7eb"
                  strokeWidth="2"
                />
              </g>
            );
          })}

          {/* Grid: horizontal W lines */}
          {Array.from({ length: 7 }).map((_, i) => {
            const W = i * 0.005;
            const y = yScale(W);
            return (
              <g key={`h-${W}`}>
                <line
                  x1={xScale(CHART.minDb)}
                  y1={y}
                  x2={xScale(CHART.maxDb)}
                  y2={y}
                  stroke="#e5e7eb"
                  strokeWidth="2"
                />
              </g>
            );
          })}

          {/* Axes with labels */}
          <line
            x1={xScale(CHART.minDb)}
            y1={yScale(CHART.minW)}
            x2={xScale(CHART.maxDb)}
            y2={yScale(CHART.minW)}
            stroke="#111827"
            strokeWidth="2.5"
          />
          <line
            x1={xScale(CHART.minDb)}
            y1={yScale(CHART.minW)}
            x2={xScale(CHART.minDb)}
            y2={yScale(CHART.maxW)}
            stroke="#111827"
            strokeWidth="2.5"
          />

          {/* X-axis labels (Dry Bulb) */}
          {Array.from({ length: 13 }).map((_, i) => {
            const db = CHART.minDb + i * 5;
            const x = xScale(db);
            return (
              <text key={`xlbl-${db}`} x={x} y={CHART.height - 5} textAnchor="middle" fontSize="11" fill="#374151">
                {db}
              </text>
            );
          })}

          {/* Y-axis labels (Humidity Ratio) */}
          {Array.from({ length: 7 }).map((_, i) => {
            const W = i * 0.005;
            const y = yScale(W);
            return (
              <text key={`ylbl-${W}`} x={50} y={y + 4} textAnchor="middle" fontSize="11" fill="#374151">
                {W.toFixed(3)}
              </text>
            );
          })}

          {/* Saturation curve */}
          <path d={saturationPath} fill="none" stroke="#2563eb" strokeWidth="3" />

          {/* RH curves with labels */}
          {rhCurves.map((curve) => {
            const db44 = 44;
            const W44 = Math.min(humidityRatioFromDbRh(db44, curve.rh, P), CHART.maxW);
            const x44 = xScale(db44);
            const y44 = yScale(W44);
            return (
              <g key={curve.rh}>
                <path d={curve.path} fill="none" stroke="#9ca3af" strokeWidth="2" strokeDasharray="5 5" />
                <text x={x44} y={y44 - 8} fontSize="11" fontWeight="600" fill="#6b7280">
                  {curve.rh}%
                </text>
              </g>
            );
          })}

          {/* Process lines */}
          {processLines.map((line) => (
            <line
              key={line.id}
              x1={line.x1}
              y1={line.y1}
              x2={line.x2}
              y2={line.y2}
              stroke={line.color}
              strokeWidth="3"
              strokeDasharray={line.dash}
            />
          ))}

          {/* Points */}
          {chartPoints.map((item) => {
            const x = xScale(item.point.db);
            const y = yScale(item.point.W);
            return (
              <g key={item.id}>
                <circle cx={x} cy={y} r={6} fill={item.color} stroke="white" strokeWidth="2" />
                <text x={x + 10} y={y - 10} fontSize="13" fontWeight="bold" fill={item.color}>
                  {item.label}
                </text>
              </g>
            );
          })}

          {/* Axis labels */}
          <text
            x={(xScale(CHART.minDb) + xScale(CHART.maxDb)) / 2}
            y={CHART.height - 38}
            textAnchor="middle"
            fontSize="13"
            fontWeight="bold"
            fill="#111827"
          >
            Dry Bulb Temperature (°C)
          </text>

          <text
            x={15}
            y={(yScale(CHART.minW) + yScale(CHART.maxW)) / 2}
            textAnchor="middle"
            fontSize="13"
            fontWeight="bold"
            fill="#111827"
            transform={`rotate(-90, 15, ${(yScale(CHART.minW) + yScale(CHART.maxW)) / 2})`}
          >
            Humidity Ratio (kg/kg)
          </text>
        </svg>
      </div>

      <hr />

      <h3>4) Process Results</h3>
      <p><strong>Process Type:</strong> {result.label}</p>

      {result.p3 && (
        <>
          <h4>Second Stream (for Mixing)</h4>
          <ul>
            <li>DB: {result.p3.db.toFixed(2)} °C</li>
            <li>RH: {result.p3.rh.toFixed(2)} %</li>
            <li>W: {result.p3.W.toFixed(4)} kg/kg dry air</li>
            <li>h: {result.p3.h.toFixed(2)} kJ/kg dry air</li>
          </ul>
        </>
      )}

      <h4>Leaving / Resulting Point</h4>
      <ul>
        <li>Dry Bulb: {result.p2.db.toFixed(2)} °C</li>
        <li>RH: {result.p2.rh.toFixed(2)} %</li>
        <li>Humidity Ratio: {result.p2.W.toFixed(4)} kg/kg dry air</li>
        <li>Enthalpy: {result.p2.h.toFixed(2)} kJ/kg dry air</li>
        <li>Dew Point: {result.p2.dp.toFixed(2)} °C</li>
        <li>Wet Bulb (approx): {result.p2.wb.toFixed(2)} °C</li>
      </ul>

      <h4>Load / Moisture Summary</h4>
      <ul>
        <li>Total Load: {result.totalKW.toFixed(2)} kW</li>
        <li>Sensible Load: {result.sensibleKW.toFixed(2)} kW</li>
        <li>Latent Load: {result.latentKW.toFixed(2)} kW</li>
        <li>Moisture Change: {result.moistureKgHr.toFixed(2)} kg/h</li>
      </ul>

      <hr />

      <h3>5) Generate Report</h3>
      <button onClick={() => setShowReport(true)} style={{ padding: "10px 20px", fontSize: "16px", cursor: "pointer" }}>
        Generate Report
      </button>

      {showReport && (
        <ReportModal
          p1={p1}
          p2={result.p2}
          p3={result.p3}
          mode={mode}
          label={result.label}
          totalKW={result.totalKW}
          sensibleKW={result.sensibleKW}
          latentKW={result.latentKW}
          moistureKgHr={result.moistureKgHr}
          mda1={mda1}
          mda3={mda3}
          alt={alt}
          onClose={() => setShowReport(false)}
        />
      )}

      <hr />

      <h3>Engineering Notes</h3>
      <ul>
        <li>
          <strong>Sensible mode</strong>: W stays constant, so the process is horizontal on the chart.
        </li>
        <li>
          <strong>Generic Conditioning</strong>: useful for state-to-state evaluation, but still not a true cooling coil / ADP / BF line.
        </li>
        <li>
          <strong>Mixing mode</strong>: already useful for OA + RA studies and debugging mixed air conditions.
        </li>
        <li>
          This version is ideal for moving toward a real HandsDown-like workflow.
        </li>
      </ul>
    </div>
  );
}

interface ReportModalProps {
  p1: Point;
  p2: Point;
  p3?: Point;
  mode: "sensible" | "condition" | "mixing";
  label: string;
  totalKW: number;
  sensibleKW: number;
  latentKW: number;
  moistureKgHr: number;
  mda1: number;
  mda3: number;
  alt: number;
  onClose: () => void;
}

function ReportModal({
  p1,
  p2,
  p3,
  mode,
  label,
  totalKW,
  sensibleKW,
  latentKW,
  moistureKgHr,
  mda1,
  mda3,
  alt,
  onClose,
}: ReportModalProps) {
  const handlePrint = () => {
    window.print();
  };

  const handleDownload = () => {
    const element = document.getElementById("report-content");
    if (!element) return;
    const html = element.innerHTML;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "psychrometric-report.html";
    a.click();
    URL.revokeObjectURL(url);
  };

  const P_mmHg = p1.P * 7.50062;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        zIndex: 1000,
        padding: 20,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "white",
          borderRadius: 8,
          padding: 30,
          maxWidth: 900,
          maxHeight: "90vh",
          overflowY: "auto",
          boxShadow: "0 10px 40px rgba(0,0,0,0.3)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div id="report-content" style={{ fontSize: 14, lineHeight: 1.6, color: "#333" }}>
          <div style={{ textAlign: "center", marginBottom: 30 }}>
            <h1 style={{ fontSize: 24, margin: "0 0 10px 0" }}>PSYCHROMETRIC ANALYSIS REPORT</h1>
            <p style={{ margin: 5 }}>STATE POINT & PROCESS REPORT</p>
            <p style={{ margin: 5, fontSize: 12 }}>Generated on {new Date().toLocaleDateString()}</p>
          </div>

          <div style={{ marginBottom: 20 }}>
            <h3 style={{ borderBottom: "2px solid #333", paddingBottom: 10 }}>Project Information</h3>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                <tr>
                  <td style={{ padding: 8 }}>
                    <strong>Altitude:</strong>
                  </td>
                  <td style={{ padding: 8 }}>{alt.toFixed(3)} Meters</td>
                </tr>
                <tr>
                  <td style={{ padding: 8 }}>
                    <strong>Atmospheric Pressure:</strong>
                  </td>
                  <td style={{ padding: 8 }}>
                    {p1.P.toFixed(3)} kPa / {P_mmHg.toFixed(2)} mm Hg
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: 8 }}>
                    <strong>Process Type:</strong>
                  </td>
                  <td style={{ padding: 8 }}>{label}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div style={{ marginBottom: 20 }}>
            <h3 style={{ borderBottom: "2px solid #333", paddingBottom: 10 }}>State Point 1 Data</h3>
            <table style={{ width: "100%", borderCollapse: "collapse", border: "1px solid #ddd" }}>
              <thead>
                <tr style={{ background: "#f5f5f5" }}>
                  <th style={{ padding: 8, textAlign: "left", border: "1px solid #ddd" }}>Parameter</th>
                  <th style={{ padding: 8, textAlign: "left", border: "1px solid #ddd" }}>Value</th>
                  <th style={{ padding: 8, textAlign: "left", border: "1px solid #ddd" }}>Unit</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>Dry Bulb Temperature</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>{p1.db.toFixed(2)}</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>°C</td>
                </tr>
                <tr>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>Relative Humidity</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>{p1.rh.toFixed(2)}</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>%</td>
                </tr>
                <tr>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>Wet Bulb Temperature</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>{p1.wb.toFixed(2)}</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>°C</td>
                </tr>
                <tr>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>Dew Point Temperature</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>{p1.dp.toFixed(2)}</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>°C</td>
                </tr>
                <tr>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>Humidity Ratio</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>{(p1.W * 1000).toFixed(2)}</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>g/kg</td>
                </tr>
                <tr>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>Enthalpy</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>{p1.h.toFixed(2)}</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>kJ/kg</td>
                </tr>
                <tr>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>Air Flow Rate</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>{mda1.toFixed(0)}</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>kg/h</td>
                </tr>
              </tbody>
            </table>
          </div>

          {p3 && mode === "mixing" && (
            <div style={{ marginBottom: 20 }}>
              <h3 style={{ borderBottom: "2px solid #333", paddingBottom: 10 }}>State Point 3 Data (Mixing Stream)</h3>
              <table style={{ width: "100%", borderCollapse: "collapse", border: "1px solid #ddd" }}>
                <thead>
                  <tr style={{ background: "#f5f5f5" }}>
                    <th style={{ padding: 8, textAlign: "left", border: "1px solid #ddd" }}>Parameter</th>
                    <th style={{ padding: 8, textAlign: "left", border: "1px solid #ddd" }}>Value</th>
                    <th style={{ padding: 8, textAlign: "left", border: "1px solid #ddd" }}>Unit</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{ padding: 8, border: "1px solid #ddd" }}>Dry Bulb Temperature</td>
                    <td style={{ padding: 8, border: "1px solid #ddd" }}>{p3.db.toFixed(2)}</td>
                    <td style={{ padding: 8, border: "1px solid #ddd" }}>°C</td>
                  </tr>
                  <tr>
                    <td style={{ padding: 8, border: "1px solid #ddd" }}>Relative Humidity</td>
                    <td style={{ padding: 8, border: "1px solid #ddd" }}>{p3.rh.toFixed(2)}</td>
                    <td style={{ padding: 8, border: "1px solid #ddd" }}>%</td>
                  </tr>
                  <tr>
                    <td style={{ padding: 8, border: "1px solid #ddd" }}>Humidity Ratio</td>
                    <td style={{ padding: 8, border: "1px solid #ddd" }}>{(p3.W * 1000).toFixed(2)}</td>
                    <td style={{ padding: 8, border: "1px solid #ddd" }}>g/kg</td>
                  </tr>
                  <tr>
                    <td style={{ padding: 8, border: "1px solid #ddd" }}>Enthalpy</td>
                    <td style={{ padding: 8, border: "1px solid #ddd" }}>{p3.h.toFixed(2)}</td>
                    <td style={{ padding: 8, border: "1px solid #ddd" }}>kJ/kg</td>
                  </tr>
                  <tr>
                    <td style={{ padding: 8, border: "1px solid #ddd" }}>Air Flow Rate</td>
                    <td style={{ padding: 8, border: "1px solid #ddd" }}>{mda3.toFixed(0)}</td>
                    <td style={{ padding: 8, border: "1px solid #ddd" }}>kg/h</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          <div style={{ marginBottom: 20 }}>
            <h3 style={{ borderBottom: "2px solid #333", paddingBottom: 10 }}>State Point 2 Data (Result)</h3>
            <table style={{ width: "100%", borderCollapse: "collapse", border: "1px solid #ddd" }}>
              <thead>
                <tr style={{ background: "#f5f5f5" }}>
                  <th style={{ padding: 8, textAlign: "left", border: "1px solid #ddd" }}>Parameter</th>
                  <th style={{ padding: 8, textAlign: "left", border: "1px solid #ddd" }}>Value</th>
                  <th style={{ padding: 8, textAlign: "left", border: "1px solid #ddd" }}>Unit</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>Dry Bulb Temperature</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>{p2.db.toFixed(2)}</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>°C</td>
                </tr>
                <tr>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>Relative Humidity</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>{p2.rh.toFixed(2)}</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>%</td>
                </tr>
                <tr>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>Wet Bulb Temperature</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>{p2.wb.toFixed(2)}</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>°C</td>
                </tr>
                <tr>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>Dew Point Temperature</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>{p2.dp.toFixed(2)}</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>°C</td>
                </tr>
                <tr>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>Humidity Ratio</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>{(p2.W * 1000).toFixed(2)}</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>g/kg</td>
                </tr>
                <tr>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>Enthalpy</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>{p2.h.toFixed(2)}</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>kJ/kg</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div style={{ marginBottom: 20 }}>
            <h3 style={{ borderBottom: "2px solid #333", paddingBottom: 10 }}>Process Energy Analysis</h3>
            <table style={{ width: "100%", borderCollapse: "collapse", border: "1px solid #ddd" }}>
              <thead>
                <tr style={{ background: "#f5f5f5" }}>
                  <th style={{ padding: 8, textAlign: "left", border: "1px solid #ddd" }}>Parameter</th>
                  <th style={{ padding: 8, textAlign: "left", border: "1px solid #ddd" }}>Value</th>
                  <th style={{ padding: 8, textAlign: "left", border: "1px solid #ddd" }}>Unit</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>Total Energy</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>{totalKW.toFixed(2)}</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>kW</td>
                </tr>
                <tr>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>Sensible Energy</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>{sensibleKW.toFixed(2)}</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>kW</td>
                </tr>
                <tr>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>Latent Energy</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>{latentKW.toFixed(2)}</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>kW</td>
                </tr>
                <tr>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>Sensible Heat Ratio</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>
                    {totalKW === 0 ? "N/A" : (sensibleKW / totalKW).toFixed(3)}
                  </td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>-</td>
                </tr>
                <tr>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>Moisture Change</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>{moistureKgHr.toFixed(2)}</td>
                  <td style={{ padding: 8, border: "1px solid #ddd" }}>kg/h</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ marginTop: 20, display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            onClick={handlePrint}
            style={{
              padding: "10px 20px",
              background: "#2563eb",
              color: "white",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            Print
          </button>
          <button
            onClick={handleDownload}
            style={{
              padding: "10px 20px",
              background: "#059669",
              color: "white",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            Download
          </button>
          <button
            onClick={onClose}
            style={{
              padding: "10px 20px",
              background: "#6b7280",
              color: "white",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
