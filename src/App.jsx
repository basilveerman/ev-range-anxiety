import { useState, useCallback, useMemo } from "react";
import RouteMap from "./RouteMap.jsx";

// ─── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_EV_RANGE = 250;
const CHARGE_STOP_MINUTES = 25;
const MAX_PLAUSIBLE_MPH = 150;
const MIN_SEG_MILES = 5;
const OVERNIGHT_CHARGE_HOURS = 4;
const DRIVING_TYPES = new Set(["in passenger vehicle", "unknown", "motorcycling"]);
const DATA_GAP_DAYS = 14;
const DATA_GAP_MS = DATA_GAP_DAYS * 86400 * 1000;

// ─── Geo ──────────────────────────────────────────────────────────────────────
function parseGeo(geoStr) {
  if (!geoStr) return null;
  const m = geoStr.match(/geo:([-\d.]+),([-\d.]+)/);
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
}
function geoDistMi([la1,lo1],[la2,lo2]) {
  const R = 3958.8, r = Math.PI/180;
  const dLat = (la2-la1)*r, dLon = (lo2-lo1)*r;
  const a = Math.sin(dLat/2)**2 + Math.cos(la1*r)*Math.cos(la2*r)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ─── Parser ───────────────────────────────────────────────────────────────────
function parseData(json) {
  const arr = Array.isArray(json) ? json : [];
  const segments = [];
  const visits = [];

  for (const entry of arr) {
    const startTs = new Date(entry.startTime).getTime();
    const endTs   = new Date(entry.endTime).getTime();
    const durationHrs = (endTs - startTs) / 3600000;

    if (entry.activity) {
      const act = entry.activity;
      const type = act.topCandidate?.type ?? "";
      if (!DRIVING_TYPES.has(type)) continue;
      const miles = parseFloat(act.distanceMeters ?? 0) / 1609.34;
      if (miles < MIN_SEG_MILES) continue;
      if (durationHrs > 0 && miles / durationHrs > MAX_PLAUSIBLE_MPH) continue;
      const startGeo = parseGeo(act.start);
      const endGeo   = parseGeo(act.end);
      segments.push({ startTs, endTs, miles, durationHrs, type, startGeo, endGeo });
    }

    if (entry.visit) {
      const v = entry.visit;
      const geo = parseGeo(v.topCandidate?.placeLocation);
      const semType = v.topCandidate?.semanticType ?? "Unknown";
      const placeId = v.topCandidate?.placeID ?? null;
      visits.push({ startTs, endTs, durationHrs, geo, semType, placeId, isHome: semType === "Home" || semType === "Inferred Home" });
    }
  }

  segments.sort((a,b) => a.startTs - b.startTs);
  visits.sort((a,b) => a.startTs - b.startTs);

  for (const seg of segments) {
    const before = visits.filter(v => v.endTs <= seg.startTs);
    const after  = visits.filter(v => v.startTs >= seg.endTs);
    seg.visitBefore = before.length ? before[before.length - 1] : null;
    seg.visitAfter  = after.length  ? after[0] : null;
  }

  return { segments, visits };
}

function cycleWaypoints(cycle) {
  const pts = [];
  const seen = new Set();
  const add = (geo, semType, label) => {
    if (!geo) return;
    const k = `${geo[0].toFixed(3)},${geo[1].toFixed(3)}`;
    if (seen.has(k)) return;
    seen.add(k);
    pts.push({ geo, semType, label });
  };
  for (let i = 0; i < cycle.segments.length; i++) {
    const seg = cycle.segments[i];
    if (i === 0 && seg.visitBefore) add(seg.visitBefore.geo, seg.visitBefore.semType, "Start");
    else if (i === 0) add(seg.startGeo, null, "Start");
    if (seg.visitAfter) add(seg.visitAfter.geo, seg.visitAfter.semType, i === cycle.segments.length - 1 ? "End" : "Stop");
    else add(seg.endGeo, null, i === cycle.segments.length - 1 ? "End" : "Stop");
  }
  return pts;
}

// ─── Core analysis ────────────────────────────────────────────────────────────
function findDataGaps(segments, visits) {
  const allEntries = [
    ...segments.map(s => ({ startTs: s.startTs, endTs: s.endTs })),
    ...visits.map(v => ({ startTs: v.startTs, endTs: v.endTs })),
  ].sort((a, b) => a.startTs - b.startTs);

  const gaps = [];
  for (let i = 1; i < allEntries.length; i++) {
    const gapMs = allEntries[i].startTs - allEntries[i-1].endTs;
    if (gapMs > DATA_GAP_MS) {
      gaps.push({ fromTs: allEntries[i-1].endTs, toTs: allEntries[i].startTs, days: Math.round(gapMs / 86400000) });
    }
  }
  return gaps;
}

function buildDrivingDays(segments, visits, homeGeos, evRange) {
  if (!segments.length) return [];

  function isChargerVisit(visit) {
    if (visit.durationHrs < OVERNIGHT_CHARGE_HOURS) return false;
    if (visit.isHome) return true;
    if (!visit.geo || !homeGeos.length) return false;
    return homeGeos.some(hg => geoDistMi(hg, visit.geo) < 0.5);
  }

  const chargeWindows = visits.filter(isChargerVisit);
  const dataGaps = findDataGaps(segments, visits);

  const days = [];
  let group = [];

  function flushGroup(splitByGap = false) {
    if (!group.length) return;
    const totalMiles = group.reduce((s,g) => s + g.miles, 0);
    const startTs = group[0].startTs;
    const endTs = group[group.length-1].endTs;
    let charge = evRange;
    let publicStops = 0;
    for (const seg of group) {
      if (seg.miles > charge) {
        publicStops += Math.ceil((seg.miles - charge) / evRange);
        charge = evRange - (seg.miles % evRange || evRange);
      } else {
        charge -= seg.miles;
      }
    }
    days.push({
      id: days.length,
      startTs, endTs,
      segments: [...group],
      totalMiles: Math.round(totalMiles),
      publicStops,
      needsStop: publicStops > 0,
      splitByGap,
    });
    group = [];
  }

  let chargeIdx = 0;
  let gapIdx = 0;

  for (const seg of segments) {
    while (gapIdx < dataGaps.length && dataGaps[gapIdx].toTs <= seg.startTs) {
      if (group.length > 0 && dataGaps[gapIdx].fromTs >= group[group.length-1].endTs) {
        flushGroup(true);
      }
      gapIdx++;
    }
    while (chargeIdx < chargeWindows.length && chargeWindows[chargeIdx].endTs <= seg.startTs) {
      if (group.length > 0) {
        const lastEnd = group[group.length-1].endTs;
        const cw = chargeWindows[chargeIdx];
        if (cw.startTs >= lastEnd) flushGroup(false);
      }
      chargeIdx++;
    }
    group.push(seg);
  }
  flushGroup(false);

  return days;
}

function findFrequentNonHomeStops(visits, homeGeos, topN = 12) {
  const RADIUS_MI = 0.3;
  const candidates = visits.filter(v =>
    v.durationHrs >= OVERNIGHT_CHARGE_HOURS &&
    !v.isHome &&
    v.geo &&
    !homeGeos.some(hg => geoDistMi(hg, v.geo) < 0.5)
  );

  const clusters = [];
  for (const v of candidates) {
    const existing = clusters.find(c => geoDistMi(c.geo, v.geo) < RADIUS_MI);
    if (existing) { existing.count++; existing.visits.push(v); }
    else clusters.push({ geo: v.geo, count: 1, visits: [v], semType: v.semType });
  }

  return clusters.sort((a,b) => b.count - a.count).slice(0, topN);
}

// ─── Formatters ───────────────────────────────────────────────────────────────
function fmtDate(ts) {
  return new Date(ts).toLocaleDateString("en-US", { month:"short", day:"numeric", year:"numeric" });
}
function fmtYear(ts) { return new Date(ts).getFullYear(); }

function buildYearStats(days) {
  const by = {};
  for (const d of days) {
    const y = fmtYear(d.startTs);
    if (!by[y]) by[y] = { total:0, bad:0 };
    by[y].total++;
    if (d.needsStop) by[y].bad++;
  }
  return Object.entries(by).sort(([a],[b])=>a-b).map(([year,s])=>({year,...s}));
}

// ─── Design tokens ────────────────────────────────────────────────────────────
const C = {
  bg:"#070709", surface:"#0d0d10", border:"#1c1c22",
  green:"#4ade80", greenDim:"#122a1c", greenBorder:"#1e5c35",
  orange:"#fb923c", orangeBorder:"#7c3410",
  yellow:"#facc15", blue:"#60a5fa", blueDim:"#0d1f3a",
  text:"#eeeef2", muted:"#7a7a8a", faint:"#3a3a48",
  font:"'DM Sans',system-ui,sans-serif",
  mono:"'DM Mono','Fira Mono',monospace",
  serif:"'DM Serif Display',Georgia,serif",
};

// ─── Stat card ────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, color }) {
  return (
    <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:10, padding:"14px 16px" }}>
      <div style={{ color:C.faint, fontSize:9, textTransform:"uppercase", letterSpacing:"0.13em", fontFamily:C.mono, marginBottom:6 }}>{label}</div>
      <div style={{ color:color||C.text, fontSize:26, fontWeight:700, fontFamily:C.serif, lineHeight:1.1 }}>{value}</div>
      {sub && <div style={{ color:C.muted, fontSize:11, marginTop:4 }}>{sub}</div>}
    </div>
  );
}

// ─── Year chart ───────────────────────────────────────────────────────────────
function YearChart({ yearStats }) {
  const max = Math.max(...yearStats.map(y => y.total), 1);
  return (
    <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:10, padding:"16px 18px" }}>
      <div style={{ color:C.faint, fontSize:9, textTransform:"uppercase", letterSpacing:"0.13em", fontFamily:C.mono, marginBottom:14 }}>Charge cycles by year</div>
      <div style={{ display:"flex", alignItems:"flex-end", gap:4, height:72 }}>
        {yearStats.map(y => (
          <div key={y.year} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center" }}>
            <div style={{ width:"100%", display:"flex", flexDirection:"column", justifyContent:"flex-end", height:56 }}>
              <div style={{ width:"100%", background:C.orange, borderRadius:"2px 2px 0 0", height:`${(y.bad/max)*56}px`, minHeight:y.bad>0?2:0 }} />
              <div style={{ width:"100%", background:C.greenDim, height:`${((y.total-y.bad)/max)*56}px` }} />
            </div>
            <div style={{ color:C.faint, fontSize:8, fontFamily:C.mono, marginTop:4, transform:"rotate(-45deg)", transformOrigin:"top center", whiteSpace:"nowrap" }}>{y.year}</div>
          </div>
        ))}
      </div>
      <div style={{ display:"flex", gap:14, marginTop:20 }}>
        {[[C.greenDim,"No public stop"],[C.orange,"Needs public stop"]].map(([bg,lbl])=>(
          <div key={lbl} style={{ display:"flex", alignItems:"center", gap:5 }}>
            <div style={{ width:8, height:8, background:bg, borderRadius:2, border:`1px solid ${C.border}` }} />
            <span style={{ color:C.muted, fontSize:11 }}>{lbl}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Day row ──────────────────────────────────────────────────────────────────
function DayRow({ day, evRange, excluded, onToggleExclude, onAddCharger }) {
  const [open, setOpen] = useState(false);
  const [places, setPlaces] = useState(null);
  const pct = (day.totalMiles / evRange) * 100;

  const handleToggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    if (next && places === null) {
      const wps = cycleWaypoints(day);
      setPlaces(wps.map(wp => ({
        ...wp,
        name: wp.geo
          ? (wp.semType && wp.semType !== "Unknown" ? wp.semType : `${wp.geo[0].toFixed(3)}, ${wp.geo[1].toFixed(3)}`)
          : "Unknown",
      })));
    }
  }, [open, places, day]);

  const semIcon = s => ({ Home:"🏠", Work:"🏢", "Inferred Home":"🏠", "Inferred Work":"🏢", "Searched Address":"📍" }[s] ?? "📍");

  const borderColor = excluded ? "#2a2a2a" : day.needsStop ? C.orangeBorder : C.border;
  const accentColor = excluded ? "#333" : day.needsStop ? C.orange : C.greenBorder;

  return (
    <div style={{
      background: excluded ? "#08080a" : "#09090b",
      border:`1px solid ${borderColor}`,
      borderLeft:`3px solid ${accentColor}`,
      borderRadius:8, overflow:"hidden",
      opacity: excluded ? 0.5 : 1,
      transition:"opacity 0.2s",
    }}>
      <div style={{ padding:"11px 14px", display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
        <div style={{ cursor:"pointer", flex:1, minWidth:0 }} onClick={handleToggle}>
          <div style={{ color: excluded ? C.faint : C.text, fontWeight:600, fontSize:13 }}>
            {fmtDate(day.startTs)}{day.segments.length > 1 ? ` · ${day.segments.length} segments` : ""}
            {excluded && <span style={{ color:C.faint, fontSize:10, fontFamily:C.mono, marginLeft:8 }}>excluded</span>}
          </div>
          <div style={{ color:C.faint, fontSize:11, marginTop:2 }}>
            {day.segments.length} drive{day.segments.length>1?"s":""} chained · {open ? "▲ collapse" : "▼ expand"}
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"flex-start", gap:8, flexShrink:0 }}>
          <div style={{ textAlign:"right", cursor:"pointer" }} onClick={handleToggle}>
            <div style={{ color: excluded ? C.faint : day.needsStop?C.orange:C.green, fontWeight:700, fontSize:16, fontFamily:C.mono }}>{day.totalMiles} mi</div>
            {!excluded && (day.needsStop
              ? <div style={{ color:C.orange, fontSize:10, marginTop:2 }}>⚡ {day.publicStops} stop{day.publicStops>1?"s":""} · ~{day.publicStops*CHARGE_STOP_MINUTES}min</div>
              : <div style={{ color:C.greenBorder, fontSize:10, marginTop:2 }}>✓ within range</div>)}
          </div>
          <button
            onClick={e => { e.stopPropagation(); onToggleExclude(day.id); }}
            title={excluded ? "Re-include this cycle" : "Exclude (e.g. rental car, vacation)"}
            style={{
              background: excluded ? "#1a2a1a" : "#1a0e0e",
              border:`1px solid ${excluded ? C.greenBorder : "#4d1a1a"}`,
              color: excluded ? C.green : "#f87171",
              borderRadius:5, padding:"3px 8px", fontSize:10,
              fontFamily:C.mono, cursor:"pointer", whiteSpace:"nowrap", marginTop:2,
            }}>
            {excluded ? "↩ include" : "✕ exclude"}
          </button>
        </div>
      </div>

      {!excluded && (
        <div style={{ margin:"0 14px 10px", position:"relative", height:3, background:"#161618", borderRadius:2, overflow:"hidden" }}>
          <div style={{
            position:"absolute", left:0, height:"100%",
            width:`${Math.min(pct,100)}%`,
            background: day.needsStop
              ? `linear-gradient(90deg,${C.green} ${(100/pct)}%,${C.orange} ${(100/pct)}%)`
              : C.green,
            borderRadius:2,
          }} />
        </div>
      )}

      {open && (
        <div style={{ borderTop:`1px solid ${C.border}`, padding:"12px 14px" }}>
          {places === null && (
            <div style={{ color:C.faint, fontSize:12, marginBottom:10 }}>Resolving locations…</div>
          )}
          {places && places.filter(w=>w.geo).length >= 1 && (
            <RouteMap places={places} onAddCharger={onAddCharger} />
          )}

          {places && places.length > 0 && (
            <div style={{ marginBottom:12 }}>
              <div style={{ color:C.faint, fontSize:9, fontFamily:C.mono, textTransform:"uppercase", letterSpacing:"0.12em", marginBottom:8 }}>Route</div>
              <div style={{ display:"flex", flexDirection:"column", gap:0 }}>
                {places.map((wp, i) => (
                  <div key={i} style={{ display:"flex", alignItems:"stretch", gap:10 }}>
                    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", width:16, flexShrink:0 }}>
                      <div style={{ width:8, height:8, borderRadius:"50%", background: i===0 ? C.green : i===places.length-1 ? (day.needsStop ? C.orange : C.green) : C.blue, marginTop:2, flexShrink:0 }} />
                      {i < places.length - 1 && (
                        <div style={{ width:1, flex:1, background:"#222228", minHeight:16 }} />
                      )}
                    </div>
                    <div style={{ paddingBottom: i < places.length - 1 ? 10 : 0, flex:1, minWidth:0 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:5, flexWrap:"wrap" }}>
                        <span style={{ fontSize:11 }}>{semIcon(wp.semType)}</span>
                        <span style={{ color:C.text, fontSize:13, fontWeight: i===0||i===places.length-1 ? 600 : 400 }}>{wp.name}</span>
                        {wp.semType && wp.semType !== "Unknown" && (
                          <span style={{ color:C.faint, fontSize:10, fontFamily:C.mono }}>{wp.semType}</span>
                        )}
                      </div>
                      {wp.geo && (
                        <div style={{ marginTop:4 }}>
                          <button
                            onClick={() => onAddCharger({ lat:wp.geo[0], lon:wp.geo[1], label: wp.name || `Stop at ${wp.geo[0].toFixed(3)},${wp.geo[1].toFixed(3)}` })}
                            style={{ color:C.green, fontSize:10, fontFamily:C.mono, background:C.greenDim, border:`1px solid ${C.greenBorder}`, borderRadius:3, padding:"2px 7px", cursor:"pointer" }}>
                            + Add as charger
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ color:C.faint, fontSize:9, fontFamily:C.mono, textTransform:"uppercase", letterSpacing:"0.12em", marginBottom:6 }}>Segments</div>
          <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
            {day.segments.map((s,i) => {
              const segPct = (s.miles / evRange) * 100;
              return (
                <div key={i} style={{ background:"#0d0d10", border:`1px solid ${C.border}`, borderRadius:6, padding:"7px 10px" }}>
                  <div style={{ display:"flex", justifyContent:"space-between", color:C.muted, fontSize:12 }}>
                    <span style={{ fontFamily:C.mono }}>
                      {new Date(s.startTs).toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"})}
                      {" → "}
                      {new Date(s.endTs).toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"})}
                    </span>
                    <span style={{ color: s.miles > evRange ? C.orange : C.muted, fontFamily:C.mono, fontWeight: s.miles > evRange ? 600 : 400 }}>
                      {Math.round(s.miles)} mi · {s.type}
                    </span>
                  </div>
                  <div style={{ marginTop:5, height:2, background:"#161618", borderRadius:1, overflow:"hidden" }}>
                    <div style={{ height:"100%", width:`${Math.min(segPct,100)}%`, background: s.miles > evRange ? C.orange : C.greenBorder, borderRadius:1 }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Date filter ──────────────────────────────────────────────────────────────
function DateFilter({ minTs, maxTs, value, onChange }) {
  const toDateStr = ts => new Date(ts).toISOString().slice(0,10);
  const [from, to] = value;
  return (
    <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
      <input type="date" value={toDateStr(from)} min={toDateStr(minTs)} max={toDateStr(to)}
        onChange={e => onChange([new Date(e.target.value).getTime(), to])}
        style={{ background:C.surface, border:`1px solid ${C.border}`, color:C.text, borderRadius:6, padding:"4px 8px", fontSize:12, fontFamily:C.mono }} />
      <span style={{ color:C.faint, fontSize:12 }}>→</span>
      <input type="date" value={toDateStr(to)} min={toDateStr(from)} max={toDateStr(maxTs)}
        onChange={e => onChange([from, new Date(e.target.value).getTime()])}
        style={{ background:C.surface, border:`1px solid ${C.border}`, color:C.text, borderRadius:6, padding:"4px 8px", fontSize:12, fontFamily:C.mono }} />
      <button onClick={() => onChange([minTs, maxTs])}
        style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.muted, borderRadius:6, padding:"4px 10px", fontSize:11, fontFamily:C.mono, cursor:"pointer" }}>
        All time
      </button>
    </div>
  );
}

// ─── Sidebar: EV range slider ─────────────────────────────────────────────────
function RangeSlider({ evRange, onChange }) {
  return (
    <div style={{ background:"#0b150e", border:"1px solid #162a1c", borderRadius:10, padding:"14px 16px" }}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
        <span style={{ color:C.muted, fontSize:9, fontFamily:C.mono, textTransform:"uppercase", letterSpacing:"0.12em" }}>EV range to model</span>
        <span style={{ color:C.green, fontWeight:700, fontFamily:C.mono, fontSize:17 }}>{evRange} mi</span>
      </div>
      <input type="range" min={100} max={500} step={10} value={evRange} onChange={e=>onChange(Number(e.target.value))} />
      <div style={{ display:"flex", justifyContent:"space-between", color:C.faint, fontSize:9, marginTop:3, fontFamily:C.mono }}>
        <span>Leaf</span><span>Bolt</span><span>Model 3</span><span>Rivian</span><span>Lucid</span>
      </div>
    </div>
  );
}

// ─── Sidebar: unified charger locations + suggestions ─────────────────────────
function ChargerPanel({ detectedHomes, homeLocations, suggestions, onAdd, onRemove }) {
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [label, setLabel] = useState("");
  const [showAll, setShowAll] = useState(false);

  const inputStyle = {
    background:"#0a0a0d", border:`1px solid ${C.border}`, color:C.text,
    borderRadius:5, padding:"5px 8px", fontSize:12, fontFamily:C.mono, width:"100%",
  };

  const handleAdd = () => {
    const la = parseFloat(lat), lo = parseFloat(lon);
    if (isNaN(la) || isNaN(lo)) return;
    onAdd({ lat:la, lon:lo, label: label || `Charger (${la.toFixed(3)},${lo.toFixed(3)})` });
    setLat(""); setLon(""); setLabel("");
  };

  const visibleSuggestions = showAll ? suggestions : suggestions.slice(0, 5);
  const hasAnything = detectedHomes.length > 0 || homeLocations.length > 0;

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
      <div style={{ color:C.faint, fontSize:9, fontFamily:C.mono, textTransform:"uppercase", letterSpacing:"0.13em", marginBottom:2 }}>
        Charge locations
      </div>
      <div style={{ color:C.muted, fontSize:11, lineHeight:1.6 }}>
        Overnight stays here reset your battery before the next trip.
      </div>

      {/* Google-detected homes */}
      {detectedHomes.map((h, i) => (
        <div key={i} style={{ background:"#0a1a0e", border:`1px solid ${C.greenBorder}`, borderRadius:7, overflow:"hidden" }}>
          <RouteMap places={[{ geo: h.geo, name: h.label }]} height={140} borderRadius={0} marginBottom={0} />
          <div style={{ padding:"9px 11px", display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
            <div style={{ minWidth:0 }}>
              <div style={{ color:C.text, fontSize:12, fontWeight:600 }}>🏠 {h.label}</div>
              <div style={{ color:C.faint, fontSize:10, fontFamily:C.mono, marginTop:2 }}>
                {h.geo[0].toFixed(4)}, {h.geo[1].toFixed(4)} · {h.count} visit{h.count>1?"s":""}
              </div>
            </div>
            <span style={{ color:C.green, fontSize:10, fontFamily:C.mono, flexShrink:0, marginLeft:8 }}>auto ✓</span>
          </div>
        </div>
      ))}

      {/* User-added chargers */}
      {homeLocations.map((h, i) => (
        <div key={i} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:7, overflow:"hidden" }}>
          <RouteMap places={[{ geo: [h.lat, h.lon], name: h.label }]} height={140} borderRadius={0} marginBottom={0} />
          <div style={{ padding:"9px 11px", display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
            <div style={{ minWidth:0 }}>
              <div style={{ color:C.text, fontSize:12, fontWeight:500 }}>⚡ {h.label}</div>
              <div style={{ color:C.faint, fontSize:10, fontFamily:C.mono, marginTop:2 }}>{h.lat.toFixed(4)}, {h.lon.toFixed(4)}</div>
            </div>
            <button onClick={() => onRemove(i)}
              style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.muted, borderRadius:4, padding:"2px 7px", fontSize:10, cursor:"pointer", flexShrink:0, marginLeft:8 }}>
              ✕
            </button>
          </div>
        </div>
      ))}

      {!hasAnything && detectedHomes.length === 0 && (
        <div style={{ color:C.faint, fontSize:11 }}>No home locations detected yet in this date range.</div>
      )}

      {/* Suggestions */}
      {suggestions.length > 0 && (
        <>
          <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:10, marginTop:2 }}>
            <div style={{ color:C.faint, fontSize:9, fontFamily:C.mono, textTransform:"uppercase", letterSpacing:"0.12em", marginBottom:8 }}>
              💡 Suggested — frequent overnight stops
            </div>
            <div style={{ color:C.muted, fontSize:11, lineHeight:1.5, marginBottom:8 }}>
              These places had {OVERNIGHT_CHARGE_HOURS}+ hour stays. If you had charging access there, it would reset your battery.
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
              {visibleSuggestions.map((c, i) => {
                const lbl = c.semType !== "Unknown" ? c.semType : `Overnight stop #${i+1}`;
                const alreadyAdded = homeLocations.some(h => Math.abs(h.lat - c.geo[0]) < 0.001 && Math.abs(h.lon - c.geo[1]) < 0.001);
                return (
                  <div key={i} style={{ background:"#0a0a10", border:`1px solid #1a1a2a`, borderRadius:7, overflow:"hidden" }}>
                    <RouteMap
                      places={[{ geo: c.geo, name: lbl }]}
                      onAddCharger={alreadyAdded ? null : (h) => onAdd(h)}
                      height={150}
                      borderRadius={0}
                      marginBottom={0}
                    />
                    <div style={{ padding:"9px 11px", display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
                      <div style={{ minWidth:0 }}>
                        <div style={{ color:C.text, fontSize:12 }}>{lbl}</div>
                        <div style={{ color:C.faint, fontSize:10, fontFamily:C.mono, marginTop:2 }}>
                          {c.geo[0].toFixed(3)}, {c.geo[1].toFixed(3)} · {c.count} night{c.count>1?"s":""}
                        </div>
                      </div>
                      {alreadyAdded ? (
                        <span style={{ color:C.green, fontSize:10, fontFamily:C.mono, flexShrink:0 }}>✓ added</span>
                      ) : (
                        <button onClick={() => onAdd({ lat:c.geo[0], lon:c.geo[1], label: lbl })}
                          style={{ background:C.greenDim, border:`1px solid ${C.greenBorder}`, color:C.green, borderRadius:5, padding:"3px 9px", fontSize:10, cursor:"pointer", fontFamily:C.mono, whiteSpace:"nowrap", flexShrink:0 }}>
                          + Add
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {suggestions.length > 5 && (
                <button onClick={() => setShowAll(v => !v)}
                  style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.muted, borderRadius:5, padding:"4px 0", fontSize:11, cursor:"pointer", fontFamily:C.mono }}>
                  {showAll ? "Show fewer" : `Show ${suggestions.length - 5} more…`}
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {/* Manual add */}
      <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:10, marginTop:2 }}>
        <div style={{ color:C.faint, fontSize:9, fontFamily:C.mono, textTransform:"uppercase", letterSpacing:"0.12em", marginBottom:7 }}>Add manually</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:5, marginBottom:5 }}>
          <div>
            <div style={{ color:C.faint, fontSize:9, fontFamily:C.mono, marginBottom:2 }}>LAT</div>
            <input style={inputStyle} value={lat} onChange={e=>setLat(e.target.value)} placeholder="47.6062" />
          </div>
          <div>
            <div style={{ color:C.faint, fontSize:9, fontFamily:C.mono, marginBottom:2 }}>LON</div>
            <input style={inputStyle} value={lon} onChange={e=>setLon(e.target.value)} placeholder="-122.332" />
          </div>
        </div>
        <div style={{ display:"flex", gap:5 }}>
          <div style={{ flex:1 }}>
            <div style={{ color:C.faint, fontSize:9, fontFamily:C.mono, marginBottom:2 }}>LABEL</div>
            <input style={inputStyle} value={label} onChange={e=>setLabel(e.target.value)} placeholder="e.g. Parents' house" />
          </div>
          <div style={{ display:"flex", alignItems:"flex-end" }}>
            <button onClick={handleAdd} style={{
              background:C.greenDim, border:`1px solid ${C.greenBorder}`, color:C.green,
              borderRadius:6, padding:"6px 12px", fontSize:12, cursor:"pointer", fontFamily:C.mono, whiteSpace:"nowrap",
            }}>+ Add</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [evRange, setEvRange] = useState(DEFAULT_EV_RANGE);
  const [parsed, setParsed] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [homeLocations, setHomeLocations] = useState([]);
  const [filterMode, setFilterMode] = useState("bad");
  const [dateRange, setDateRange] = useState(null);
  const [excludedIds, setExcludedIds] = useState(new Set());

  const toggleExclude = useCallback((id) => {
    setExcludedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const homeGeos = useMemo(() => homeLocations.map(h => [h.lat, h.lon]), [homeLocations]);

  const minTs = parsed?.segments.length ? parsed.segments[0].startTs : Date.now();
  const maxTs = parsed?.segments.length ? parsed.segments[parsed.segments.length-1].endTs : Date.now();
  const effectiveDateRange = dateRange || [minTs, maxTs];

  const filteredParsed = useMemo(() => {
    if (!parsed) return null;
    const [from, to] = effectiveDateRange;
    return {
      segments: parsed.segments.filter(s => s.startTs >= from && s.endTs <= to),
      visits:   parsed.visits.filter(v => v.startTs >= from && v.endTs <= to),
    };
  }, [parsed, effectiveDateRange]);

  const days = useMemo(() => {
    if (!filteredParsed) return [];
    return buildDrivingDays(filteredParsed.segments, filteredParsed.visits, homeGeos, evRange);
  }, [filteredParsed, homeGeos, evRange]);

  const stats = useMemo(() => {
    if (!days.length) return null;
    const validDays = days.filter(d => !d.splitByGap && !excludedIds.has(d.id));
    const gapDays = days.filter(d => d.splitByGap);
    const excludedDays = days.filter(d => !d.splitByGap && excludedIds.has(d.id));
    const bad = validDays.filter(d => d.needsStop);
    const totalStops = validDays.reduce((s,d) => s + d.publicStops, 0);
    const sorted = [...validDays].sort((a,b) => b.totalMiles - a.totalMiles);
    return { bad, totalStops, sorted, validDays, gapDays, excludedDays, yearStats: buildYearStats(validDays) };
  }, [days, excludedIds]);

  const suggestions = useMemo(() => {
    if (!filteredParsed) return [];
    return findFrequentNonHomeStops(filteredParsed.visits, homeGeos);
  }, [filteredParsed, homeGeos]);

  const detectedHomes = useMemo(() => {
    if (!filteredParsed) return [];
    const homeVisits = filteredParsed.visits.filter(v => v.isHome && v.geo);
    const RADIUS_MI = 0.3;
    const clusters = [];
    for (const v of homeVisits) {
      const ex = clusters.find(c => geoDistMi(c.geo, v.geo) < RADIUS_MI);
      if (ex) ex.count++;
      else clusters.push({ geo: v.geo, count: 1, label: "Home (Google detected)" });
    }
    return clusters.sort((a,b) => b.count - a.count);
  }, [filteredParsed]);

  const displayDays = useMemo(() => {
    if (!stats) return [];
    const allWithExcluded = [...stats.sorted, ...stats.excludedDays.sort((a,b) => b.totalMiles - a.totalMiles)];
    const src = filterMode === "bad" ? stats.sorted.filter(d=>d.needsStop)
      : filterMode === "long" ? stats.sorted.filter(d=>d.totalMiles > evRange*0.7)
      : allWithExcluded;
    return src.slice(0, 100);
  }, [stats, filterMode, evRange]);

  const processFile = useCallback((file) => {
    setLoading(true); setError(null);
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const json = JSON.parse(e.target.result);
        const p = parseData(json);
        setParsed(p);
        const fiveYearsAgo = Date.now() - 5 * 365.25 * 24 * 3600 * 1000;
        const dataStart = p.segments.length ? p.segments[0].startTs : Date.now();
        setDateRange([Math.max(fiveYearsAgo, dataStart), Date.now()]);
      } catch { setError("Couldn't parse this file. Make sure it's location-history.json from Google Maps."); }
      setLoading(false);
    };
    reader.onerror = () => { setError("Failed to read file."); setLoading(false); };
    reader.readAsText(file);
  }, []);

  const chargePct = stats ? stats.bad.length / stats.validDays.length * 100 : 0;
  const verdict = !stats ? null
    : stats.bad.length === 0
    ? { icon:"🎉", title:"An EV fits your driving perfectly", color:C.green,
        body:`All ${stats.validDays.length.toLocaleString()} charge cycles fit within ${evRange} miles — no public stops needed.` }
    : chargePct <= 2
    ? { icon:"✅", title:"An EV works very well for you", color:C.green,
        body:`Only ${stats.bad.length} of ${stats.validDays.length.toLocaleString()} cycles (${chargePct.toFixed(1)}%) need a public stop.` }
    : chargePct <= 8
    ? { icon:"⚡", title:"A few longer stretches to plan for", color:C.yellow,
        body:`${stats.bad.length} of ${stats.validDays.length.toLocaleString()} cycles (${chargePct.toFixed(1)}%) exceed ${evRange} miles. Try adding more charger locations on the left.` }
    : { icon:"🔌", title:"Range is a genuine factor for you", color:C.orange,
        body:`${chargePct.toFixed(1)}% of your charge cycles need a public stop. Try a longer-range model, or add charger locations on the left.` };

  const handleAddCharger = useCallback((h) => {
    setHomeLocations(l => [...l, h]);
  }, []);

  return (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.text, fontFamily:C.font }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap');
        * { box-sizing:border-box; margin:0; }
        input[type=range]{accent-color:${C.green};width:100%;cursor:pointer;}
        input[type=date]{color-scheme:dark;}
        button{cursor:pointer;font-family:inherit;}
        .app-shell { display:flex; min-height:100vh; }
        .sidebar {
          width:300px; flex-shrink:0;
          border-right:1px solid ${C.border};
          padding:20px 16px;
          display:flex; flex-direction:column; gap:14px;
          position:sticky; top:0; height:100vh; overflow-y:auto;
        }
        .main-panel { flex:1; min-width:0; padding:24px 24px 60px; overflow-y:auto; }
        .welcome-grid { display:grid; grid-template-columns:1fr 1fr; gap:24px; align-items:start; }
        .stats-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:16px; }
        @media (max-width:820px) {
          .app-shell { flex-direction:column; }
          .sidebar { width:100%; height:auto; position:static; border-right:none; border-bottom:1px solid ${C.border}; }
          .welcome-grid { grid-template-columns:1fr; }
          .stats-grid { grid-template-columns:1fr 1fr; }
        }
        @media (max-width:480px) {
          .stats-grid { grid-template-columns:1fr; }
          .main-panel { padding:16px 14px 40px; }
          .sidebar { padding:16px 14px; }
        }
      `}</style>

      {!parsed ? (
        /* ── Welcome / upload screen ── */
        <div style={{ maxWidth:900, margin:"0 auto", padding:"40px 24px 60px" }}>
          <div style={{ marginBottom:32 }}>
            <h1 style={{ fontSize:32, fontFamily:C.serif, fontWeight:400, letterSpacing:"-0.02em", marginBottom:8 }}>
              ⚡ EV Range Reality Check
            </h1>
            <p style={{ color:C.muted, fontSize:15, lineHeight:1.7, maxWidth:560 }}>
              Upload your Google location history to see how an EV would have fit your actual driving — charge cycle by charge cycle.
            </p>
          </div>

          {/* Steps */}
          <div style={{ display:"flex", gap:0, marginBottom:36, flexWrap:"wrap" }}>
            {[
              ["①","Upload your data","Drop your Google location history JSON"],
              ["②","Add charger locations","Mark where you'd charge overnight"],
              ["③","Explore your trips","See exactly which trips needed a stop"],
            ].map(([num, title, desc], i) => (
              <div key={i} style={{ display:"flex", alignItems:"flex-start", gap:10, flex:1, minWidth:200, padding:"0 20px 0 0" }}>
                <div style={{ color:C.green, fontFamily:C.serif, fontSize:22, lineHeight:1, flexShrink:0, marginTop:2 }}>{num}</div>
                <div>
                  <div style={{ color:C.text, fontWeight:600, fontSize:14, marginBottom:3 }}>{title}</div>
                  <div style={{ color:C.muted, fontSize:12, lineHeight:1.5 }}>{desc}</div>
                </div>
                {i < 2 && <div style={{ color:C.faint, fontSize:18, alignSelf:"center", flexShrink:0, marginLeft:"auto", paddingRight:20 }}>→</div>}
              </div>
            ))}
          </div>

          <div className="welcome-grid">
            {/* Left: slider + upload */}
            <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
              <RangeSlider evRange={evRange} onChange={setEvRange} />

              <div
                onDrop={e=>{e.preventDefault();setDragOver(false);const f=e.dataTransfer.files?.[0];if(f)processFile(f);}}
                onDragOver={e=>{e.preventDefault();setDragOver(true);}}
                onDragLeave={()=>setDragOver(false)}
                onClick={()=>document.getElementById("loc-file").click()}
                style={{
                  border:`2px dashed ${dragOver?C.green:"#222228"}`, borderRadius:14,
                  padding:"36px 24px", textAlign:"center", cursor:"pointer",
                  transition:"all 0.2s", background:dragOver?"#0a1a0e":"transparent",
                }}
              >
                <div style={{ fontSize:36, marginBottom:10 }}>📍</div>
                <div style={{ color:"#ccc", fontSize:15, fontWeight:600, marginBottom:6 }}>
                  Drop location-history.json here
                </div>
                <div style={{ color:C.muted, fontSize:12, lineHeight:1.8, marginBottom:4 }}>
                  or click to browse
                </div>
                <div style={{ color:C.faint, fontSize:11, lineHeight:1.6 }}>
                  Google Maps → Profile → Settings →<br />Personal content → Export Timeline data
                </div>
                <div style={{ color:C.faint, fontSize:10, marginTop:8 }}>Processed locally · never uploaded</div>
                <input id="loc-file" type="file" accept=".json" style={{ display:"none" }}
                  onChange={e=>{const f=e.target.files?.[0];if(f)processFile(f);}} />
                {loading && <div style={{ color:C.green, marginTop:14, fontSize:13 }}>Parsing…</div>}
                {error && <div style={{ color:"#f87171", marginTop:14, fontSize:13 }}>{error}</div>}
              </div>
            </div>

            {/* Right: explainer */}
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              {[
                ["What is a charge cycle?", "Each time you sleep at home, your battery resets. We group all your drives between home sleeps into one cycle and check if they'd fit within your EV's range."],
                ["What about trips away from home?", "If you regularly stayed overnight somewhere else — a relative's place, a hotel, a cabin — you can mark those as charge locations too. They reset the cycle just like home."],
                ["What data does this use?", "Only your Google Maps Timeline (location-history.json). The file is read entirely in your browser and never sent anywhere."],
              ].map(([q, a]) => (
                <div key={q} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:10, padding:"14px 16px" }}>
                  <div style={{ color:C.text, fontWeight:600, fontSize:13, marginBottom:5 }}>{q}</div>
                  <div style={{ color:C.muted, fontSize:12, lineHeight:1.6 }}>{a}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

      ) : (
        /* ── Main two-column layout ── */
        <div className="app-shell">

          {/* ── Sidebar ── */}
          <aside className="sidebar">
            <div>
              <div style={{ fontFamily:C.serif, fontSize:18, fontWeight:400, letterSpacing:"-0.01em", marginBottom:2 }}>⚡ EV Range</div>
              <div style={{ color:C.faint, fontSize:11 }}>Reality Check</div>
            </div>

            <RangeSlider evRange={evRange} onChange={setEvRange} />

            {/* File info */}
            <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:9, padding:"11px 13px" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                <div>
                  <div style={{ color:C.green, fontSize:11, marginBottom:3 }}>✓ Data loaded</div>
                  <div style={{ color:C.muted, fontSize:11 }}>{parsed.segments.length.toLocaleString()} driving segments</div>
                  <div style={{ color:C.faint, fontSize:10, fontFamily:C.mono, marginTop:2 }}>
                    {fmtDate(minTs)} – {fmtDate(maxTs)}
                  </div>
                </div>
                <button
                  onClick={()=>{setParsed(null);setDateRange(null);setHomeLocations([]);setExcludedIds(new Set());}}
                  style={{ background:"transparent", border:`1px solid #222`, color:C.muted, padding:"3px 9px", borderRadius:6, fontSize:11 }}>
                  ← New file
                </button>
              </div>
            </div>

            {/* Charger locations */}
            <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:10, padding:"14px 14px", flex:1 }}>
              <ChargerPanel
                detectedHomes={detectedHomes}
                homeLocations={homeLocations}
                suggestions={suggestions}
                onAdd={handleAddCharger}
                onRemove={i => setHomeLocations(l => l.filter((_,j) => j !== i))}
              />
            </div>
          </aside>

          {/* ── Main panel ── */}
          <main className="main-panel">

            {/* Date filter */}
            <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:10, padding:"12px 16px", marginBottom:16 }}>
              <div style={{ color:C.faint, fontSize:9, fontFamily:C.mono, textTransform:"uppercase", letterSpacing:"0.12em", marginBottom:8 }}>
                Date range · all analysis scoped to this window
              </div>
              <DateFilter minTs={minTs} maxTs={maxTs} value={effectiveDateRange} onChange={setDateRange} />
            </div>

            {/* Verdict */}
            {verdict && (
              <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderLeft:`4px solid ${verdict.color}`, borderRadius:10, padding:"14px 18px", marginBottom:16 }}>
                <div style={{ fontFamily:C.serif, fontSize:18, marginBottom:5 }}>{verdict.icon} {verdict.title}</div>
                <div style={{ color:C.muted, fontSize:13, lineHeight:1.7 }}>{verdict.body}</div>
              </div>
            )}

            {/* Stats */}
            {stats && (
              <div className="stats-grid">
                <StatCard label="Charge cycles" value={stats.validDays.length.toLocaleString()} sub={`${stats.gapDays.length} gap · ${stats.excludedDays.length} excluded`} />
                <StatCard label="Need public stop" value={stats.bad.length} sub={`${chargePct.toFixed(1)}% of valid cycles`} color={stats.bad.length>0?C.orange:C.green} />
                <StatCard label="Total public stops" value={stats.totalStops} sub={`~${stats.totalStops*CHARGE_STOP_MINUTES}min total`} color={stats.totalStops>0?C.orange:C.green} />
                <StatCard label="Longest stretch" value={`${stats.sorted[0]?.totalMiles||0} mi`} sub={stats.sorted[0]?fmtDate(stats.sorted[0].startTs):""} color={(stats.sorted[0]?.totalMiles||0)>evRange?C.orange:C.green} />
              </div>
            )}

            {/* Data gaps notice */}
            {stats?.gapDays.length > 0 && (
              <div style={{ background:"#12100a", border:`1px solid #3d2e0a`, borderRadius:10, padding:"13px 16px", marginBottom:16 }}>
                <div style={{ color:"#d97706", fontSize:11, fontWeight:600, marginBottom:6 }}>
                  ⚠ {stats.gapDays.length} cycle{stats.gapDays.length>1?"s":""} excluded — data gaps detected
                </div>
                <div style={{ color:C.muted, fontSize:12, lineHeight:1.6 }}>
                  Periods where Google had no location data for {DATA_GAP_DAYS}+ days are treated as breaks. These cycles are excluded to avoid misleadingly large numbers.
                </div>
              </div>
            )}

            {/* Year chart */}
            {stats && <div style={{ marginBottom:16 }}><YearChart yearStats={stats.yearStats} /></div>}

            {/* Trip list */}
            {stats && (
              <>
                <div style={{ display:"flex", gap:6, alignItems:"center", marginBottom:10, flexWrap:"wrap" }}>
                  <span style={{ color:C.faint, fontSize:9, fontFamily:C.mono, textTransform:"uppercase", letterSpacing:"0.12em", marginRight:2 }}>Show:</span>
                  {[
                    ["bad", `Needs stop (${stats.bad.length})`],
                    ["long", `Long stretches (${stats.sorted.filter(d=>d.totalMiles>evRange*0.7).length})`],
                    ["all", `All valid (${stats.validDays.length})`],
                  ].map(([mode, label]) => (
                    <button key={mode} onClick={() => setFilterMode(mode)} style={{
                      background: filterMode===mode ? C.greenDim : "transparent",
                      border:`1px solid ${filterMode===mode ? C.greenBorder : "#222228"}`,
                      color: filterMode===mode ? C.green : C.muted,
                      padding:"5px 11px", borderRadius:6, fontSize:11, fontFamily:C.mono,
                    }}>{label}</button>
                  ))}
                  {excludedIds.size > 0 && (
                    <button onClick={() => setExcludedIds(new Set())} style={{
                      background:"transparent", border:`1px solid #2a2a2a`, color:C.faint,
                      padding:"5px 10px", borderRadius:6, fontSize:11, fontFamily:C.mono,
                    }}>↩ restore {excludedIds.size} excluded</button>
                  )}
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                  {displayDays.map(d => (
                    <DayRow key={d.id} day={d} evRange={evRange} excluded={excludedIds.has(d.id)}
                      onToggleExclude={toggleExclude} onAddCharger={handleAddCharger} />
                  ))}
                  {displayDays.length === 0 && (
                    <div style={{ color:C.faint, textAlign:"center", padding:"28px 0", fontSize:13 }}>No trips match this filter</div>
                  )}
                  {displayDays.length === 100 && (
                    <div style={{ color:C.faint, textAlign:"center", padding:"12px 0", fontSize:11, fontFamily:C.mono }}>Showing first 100 results</div>
                  )}
                </div>
              </>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
