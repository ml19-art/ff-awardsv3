"use strict";
/// <reference types="react" />
const { useState, useEffect, useCallback, useRef } = React;
// ─── STORAGE (localStorage cache) ────────────────────────────────────────────
async function storageGet(key) {
    try {
        const v = localStorage.getItem(key);
        return v ? { value: v } : null;
    }
    catch {
        return null;
    }
}
async function storageSet(key, val) {
    try {
        localStorage.setItem(key, typeof val === "string" ? val : JSON.stringify(val));
        return true;
    }
    catch {
        return false;
    }
}
// ─── API ──────────────────────────────────────────────────────────────────────
const FF_API = "https://www.fleaflicker.com/api/";
const LOCAL_PROXY = "";
// Android: Use native JavascriptInterface (no CORS)
// Falls back to direct fetch if bridge not available
const PROXY_FNS = [
  u => u,  // Only option: direct (works via native bridge)
];
let workingProxyIdx = 0;
function fetchT(url, ms = 9000, opts = {}) {
    // Android bridge: native HTTP, no CORS
    if (window.AndroidBridge && window.AndroidBridge.isAvailable()) {
        return new Promise((resolve, reject) => {
            const cbId = 'cb_' + Date.now() + '_' + Math.floor(Math.random() * 99999);
            const timer = setTimeout(() => {
                delete (window.ffCallbacks || {})[cbId];
                reject(new Error('Timeout'));
            }, ms);
            window.ffCallbacks = window.ffCallbacks || {};
            window.ffCallbacks[cbId] = (jsonStr) => {
                clearTimeout(timer);
                try {
                    const data = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
                    if (data && data.error) { reject(new Error(data.error)); return; }
                    resolve({
                        ok: true, status: 200,
                        text: () => Promise.resolve(typeof jsonStr === 'string' ? jsonStr : JSON.stringify(data)),
                        json: () => Promise.resolve(data),
                    });
                } catch(e) { reject(e); }
            };
            try { window.AndroidBridge.httpGet(url, cbId); }
            catch(e) { clearTimeout(timer); delete window.ffCallbacks[cbId]; reject(e); }
        });
    }
    // Fallback: standard fetch
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(id));
}
async function fetchFF(endpoint, params = {}) {
    const target = FF_API + endpoint + "?" + new URLSearchParams({ sport: "NFL", ...params });
    const order = [workingProxyIdx, ...PROXY_FNS.map((_, i) => i).filter(i => i !== workingProxyIdx)];
    let last = new Error("All proxies failed");
    for (const i of order) {
        try {
            const res = await fetchT(PROXY_FNS[i](target));
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            if (text.trim().startsWith("<"))
                throw new Error("Proxy returned HTML");
            workingProxyIdx = i;
            return JSON.parse(text);
        }
        catch (e) {
            last = e;
        }
    }
    throw last;
}
async function probeProxy(fn) {
  // On Android, native bridge always works
  if (window.AndroidBridge && window.AndroidBridge.isAvailable()) return true;
  try {
    const res = await fetchT(fn(FF_API + "FetchLeagues?sport=NFL&level=1"), 4000);
    const t = await res.text();
    return res.ok && !t.trim().startsWith("<") && t.length > 10;
  } catch { return false; }
}
function decodeJwt(token) {
    try {
        const part = token.split(".")[1] || "";
        return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")));
    }
    catch {
        return null;
    }
}
function userIdFromCookie(raw) {
    var _a, _b, _c, _d, _e;
    const val = raw.trim().replace(/^FleaFlicker\s*=\s*/i, "");
    try {
        const decoded = atob(val);
        const pipe = decoded.indexOf("|");
        if (pipe > 0) {
            const uid = decoded.slice(0, pipe);
            if (/^\d+$/.test(uid))
                return uid;
        }
    }
    catch (_) { }
    const pipe2 = val.indexOf("|");
    if (pipe2 > 0) {
        const uid2 = val.slice(0, pipe2);
        if (/^\d+$/.test(uid2))
            return uid2;
    }
    const p = decodeJwt(val);
    return p ? ((_e = (_d = (_c = (_b = (_a = p.userId) !== null && _a !== void 0 ? _a : p.user_id) !== null && _b !== void 0 ? _b : p.uid) !== null && _c !== void 0 ? _c : p.id) !== null && _d !== void 0 ? _d : p.sub) !== null && _e !== void 0 ? _e : null) : null;
}
function parseUserId(input) {
    const m = input.match(/\/nfl\/users\/(\d+)/);
    if (m)
        return m[1];
    if (/^\d+$/.test(input.trim()))
        return input.trim();
    return null;
}
async function fetchLeaguesByUserId(userId) {
    const data = await fetchFF("FetchUserLeagues", { user_id: String(userId) });
    return (data.leagues || []).map(l => ({ id: String(l.id), name: l.name || `Liga ${l.id}`, season: l.season || new Date().getFullYear() }));
}
// ─── CACHE ────────────────────────────────────────────────────────────────────
const CACHE_TTL_CURRENT = 60 * 60 * 1000; // 1h for current season
const CACHE_TTL_PAST = 7 * 24 * 60 * 60 * 1000; // 7d for past seasons
function cacheKey(leagueId, season) { return `ff_v2_${leagueId}_${season}`; }
async function loadFromCache(leagueId, season) {
    const raw = await storageGet(cacheKey(leagueId, season));
    if (!raw)
        return null;
    try {
        const obj = JSON.parse(raw.value);
        const ttl = season < new Date().getFullYear() ? CACHE_TTL_PAST : CACHE_TTL_CURRENT;
        if (Date.now() - obj.ts > ttl)
            return null;
        return obj.data;
    }
    catch {
        return null;
    }
}
async function saveToCache(leagueId, season, data) {
    await storageSet(cacheKey(leagueId, season), JSON.stringify({ ts: Date.now(), data }));
}
// ─── AWARDS ENGINE ────────────────────────────────────────────────────────────
function computeAutoAwards(data) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y;
    const { teams, weeklyScores, transactions, boxscores } = data;
    const awards = {};
    if (!(teams === null || teams === void 0 ? void 0 : teams.length))
        return awards;
    // Helpers
    const byMax = (arr, fn) => arr.reduce((b, x) => fn(x) > fn(b) ? x : b, arr[0]);
    const byMin = (arr, fn) => arr.reduce((b, x) => fn(x) < fn(b) ? x : b, arr[0]);
    const teamId = name => { var _a; return (_a = teams.find(t => t.name === name)) === null || _a === void 0 ? void 0 : _a.id; };
    // ── STANDINGS-BASED ──────────────────────────────────────────────────────
    const byPts = [...teams].sort((a, b) => b.pointsFor - a.pointsFor);
    const byLuck = [...teams].sort((a, b) => (b.luck || 0) - (a.luck || 0));
    // Validate helper: attach quality flag
    const qa = (award, checks) => {
        const issues = checks.filter(c => !c.ok).map(c => c.msg);
        return { ...award, quality: issues.length === 0 ? "ok" : issues.length < 2 ? "warn" : "low", issues };
    };
    const enoughTeams = teams.length >= 2;
    awards[14] = qa({ winner: (_a = byPts[0]) === null || _a === void 0 ? void 0 : _a.name, value: (_b = byPts[0]) === null || _b === void 0 ? void 0 : _b.pointsFor, unit: "Pts", runnerUp: (_c = byPts[1]) === null || _c === void 0 ? void 0 : _c.name }, [{ ok: enoughTeams, msg: "< 2 Teams" }, { ok: (((_d = byPts[0]) === null || _d === void 0 ? void 0 : _d.pointsFor) || 0) > 0, msg: "Keine Punkte" }]);
    awards[15] = qa({ winner: (_e = byPts.at(-1)) === null || _e === void 0 ? void 0 : _e.name, value: (_f = byPts.at(-1)) === null || _f === void 0 ? void 0 : _f.pointsFor, unit: "Pts", runnerUp: (_g = byPts.at(-2)) === null || _g === void 0 ? void 0 : _g.name }, [{ ok: enoughTeams, msg: "< 2 Teams" }]);
    const luckSrc = ((_h = teams[0]) === null || _h === void 0 ? void 0 : _h.luckSource) === "projected" ? "% vs Projection" : "Luck";
    awards[12] = qa({ winner: (_j = byLuck[0]) === null || _j === void 0 ? void 0 : _j.name, value: (_k = byLuck[0]) === null || _k === void 0 ? void 0 : _k.luck, unit: luckSrc, runnerUp: (_l = byLuck[1]) === null || _l === void 0 ? void 0 : _l.name,
        detail: ((_m = teams[0]) === null || _m === void 0 ? void 0 : _m.luckSource) === "projected" ? "Ø % über Erwartung (projected vs actual)" : "Fleaflicker Luck-Wert" }, [{ ok: enoughTeams, msg: "< 2 Teams" }, { ok: byLuck.some(t => (t.luck || 0) !== 0), msg: "Alle Luck-Werte = 0, Projektion nicht verfügbar" }]);
    awards[13] = qa({ winner: (_o = byLuck.at(-1)) === null || _o === void 0 ? void 0 : _o.name, value: (_p = byLuck.at(-1)) === null || _p === void 0 ? void 0 : _p.luck, unit: luckSrc, runnerUp: (_q = byLuck.at(-2)) === null || _q === void 0 ? void 0 : _q.name,
        detail: ((_r = teams[0]) === null || _r === void 0 ? void 0 : _r.luckSource) === "projected" ? "Ø % unter Erwartung" : "Fleaflicker Luck-Wert" }, [{ ok: enoughTeams, msg: "< 2 Teams" }]);
    // ── SCOREBOARD-BASED ────────────────────────────────────────────────────
    if (weeklyScores === null || weeklyScores === void 0 ? void 0 : weeklyScores.length) {
        const allScores = weeklyScores.flatMap(g => [
            { team: g.home, score: g.homeScore, opp: g.away, oppScore: g.awayScore, week: g.week },
            { team: g.away, score: g.awayScore, opp: g.home, oppScore: g.homeScore, week: g.week },
        ]).filter(s => s.score > 0);
        const allGames = weeklyScores.map(g => ({
            winner: g.homeScore > g.awayScore ? g.home : g.away,
            loser: g.homeScore > g.awayScore ? g.away : g.home,
            diff: Math.abs(g.homeScore - g.awayScore),
            week: g.week,
            high: Math.max(g.homeScore, g.awayScore),
            low: Math.min(g.homeScore, g.awayScore),
        })).filter(g => g.diff > 0);
        const fiesta = byMax(allScores, s => s.score);
        const klo = byMin(allScores, s => s.score);
        const zerst = byMax(allGames, g => g.diff);
        const inch = byMin(allGames, g => g.diff);
        const enoughWeeks = weeklyScores.length >= 3;
        awards[16] = qa({ winner: fiesta.team, value: fiesta.score, unit: "Pts", detail: `W${fiesta.week} vs ${fiesta.opp} (${fiesta.oppScore.toFixed(1)})` }, [{ ok: enoughWeeks, msg: "< 3 Spielwochen geladen" }, { ok: fiesta.score > 50, msg: `Score ${fiesta.score.toFixed(1)} unplausibel niedrig` }]);
        awards[17] = qa({ winner: klo.team, value: klo.score, unit: "Pts", detail: `W${klo.week} vs ${klo.opp} (${klo.oppScore.toFixed(1)})` }, [{ ok: enoughWeeks, msg: "< 3 Spielwochen" }, { ok: klo.score > 0, msg: "Score 0" }]);
        awards[18] = qa({ winner: zerst.winner, value: zerst.diff, unit: "Diff", detail: `W${zerst.week} vs ${zerst.loser}` }, [{ ok: enoughWeeks, msg: "< 3 Wochen" }, { ok: zerst.diff > 20, msg: `Diff ${zerst.diff.toFixed(1)} unplausibel klein` }]);
        awards[19] = qa({ winner: inch.loser, value: inch.diff, unit: "Diff", detail: `W${inch.week} vs ${inch.winner} (knappste Niederlage)` }, [{ ok: enoughWeeks, msg: "< 3 Wochen" }, { ok: inch.diff < 50, msg: "Differenz zu groß" }]);
        // Weekly points per team
        const teamWeekly = {};
        allScores.forEach(s => {
            if (!teamWeekly[s.team])
                teamWeekly[s.team] = [];
            teamWeekly[s.team].push(s.score);
        });
    }
    // ── TRANSACTION-BASED ───────────────────────────────────────────────────
    if (transactions === null || transactions === void 0 ? void 0 : transactions.length) {
        const txC = {};
        teams.forEach(t => { txC[t.name] = { adds: 0, waivers: 0, wBids: 0, bids: 0, trades: 0, topBid: 0 }; });
        transactions.forEach(tx => {
            const tname = tx.teamName;
            if (!txC[tname])
                return;
            switch (tx.type) {
                case "ADD":
                    txC[tname].adds++;
                    break;
                case "WAIVER_CLAIM":
                    txC[tname].waivers++;
                    break;
                case "WAIVER_WON":
                    txC[tname].wBids++;
                    txC[tname].bids++;
                    break;
                case "WAIVER_LOST":
                    txC[tname].bids++;
                    break;
                case "TRADE":
                    txC[tname].trades++;
                    break;
            }
            if (tx.bidAmount && tx.bidAmount > txC[tname].topBid)
                txC[tname].topBid = tx.bidAmount;
        });
        const txArr = Object.entries(txC).map(([name, v]) => ({ name, ...v }));
        const bA = [...txArr].sort((a, b) => b.adds - a.adds);
        const bW = [...txArr].sort((a, b) => b.waivers - a.waivers);
        const bT = [...txArr].sort((a, b) => b.trades - a.trades);
        const bM = [...txArr].filter(t => t.bids > 0).sort((a, b) => (b.wBids / b.bids) - (a.wBids / a.bids));
        const bBid = [...txArr].sort((a, b) => b.topBid - a.topBid);
        const enoughTx = transactions.length >= 5;
        if (bA[0])
            awards[3] = qa({ winner: bA[0].name, value: bA[0].adds, unit: "Adds" }, [{ ok: enoughTx, msg: "< 5 Transaktionen" }, { ok: bA[0].adds > 0, msg: "0 Adds" }]);
        if (bA.at(-1))
            awards[4] = qa({ winner: bA.at(-1).name, value: bA.at(-1).adds, unit: "Adds" }, [{ ok: enoughTx, msg: "< 5 Transaktionen" }]);
        if (bW[0])
            awards[5] = qa({ winner: bW[0].name, value: bW[0].waivers, unit: "Claims" }, [{ ok: enoughTx, msg: "< 5 Transaktionen" }, { ok: bW[0].waivers > 0, msg: "0 Waiver-Claims" }]);
        if (bW.at(-1))
            awards[6] = qa({ winner: bW.at(-1).name, value: bW.at(-1).waivers, unit: "Claims" }, [{ ok: enoughTx, msg: "< 5 Transaktionen" }]);
        if (bT[0])
            awards[9] = qa({ winner: bT[0].name, value: bT[0].trades, unit: "Trades" }, [{ ok: enoughTx, msg: "< 5 Transaktionen" }, { ok: bT[0].trades > 0, msg: "0 Trades" }]);
        if (bT.at(-1))
            awards[10] = qa({ winner: bT.at(-1).name, value: bT.at(-1).trades, unit: "Trades" }, [{ ok: enoughTx, msg: "< 5 Transaktionen" }]);
        if (bM[0])
            awards[7] = qa({ winner: bM[0].name, value: `${(bM[0].wBids / bM[0].bids * 100).toFixed(0)}%`, detail: `${bM[0].wBids}/${bM[0].bids} gewonnen` }, [{ ok: bM[0].bids >= 3, msg: `Nur ${bM[0].bids} Gebote` }]);
        if (bBid[0] && bBid[0].topBid > 0)
            awards[8] = qa({ winner: bBid[0].name, value: bBid[0].topBid, unit: "$" }, [{ ok: bBid[0].topBid > 0, msg: "Kein Auktionsbetrag" }]);
    }
    // ── BOXSCORE-BASED (if available) ────────────────────────────────────────
    if (boxscores === null || boxscores === void 0 ? void 0 : boxscores.length) {
        const teamStats = {};
        teams.forEach(t => {
            teamStats[t.name] = {
                qbPts: 0, nonQbMax: 0, nonQbName: "", benchPts: 0, taxiPts: 0,
                negStarters: 0, actualPts: 0, optimalPts: 0,
                weekBench: [], weekActual: [], weekOptimal: [], gwpMax: 0, gwpPlayer: "",
            };
        });
        boxscores.forEach(bs => {
            // Each entry: home = real team data, away = stub (ignored here)
            // Process only the home side which has the actual team's roster
            ["home"].forEach(side => {
                const sd = bs[side];
                if (!(sd === null || sd === void 0 ? void 0 : sd.teamName) || !teamStats[sd.teamName])
                    return;
                const ts = teamStats[sd.teamName];
                let wBench = 0, wActual = 0;
                const wOptimal = sd.optimalPts || 0;
                (sd.slots || []).forEach(slot => {
                    var _a, _b;
                    const pts = typeof slot.pts === "number" ? slot.pts : (parseFloat(slot.pts) || 0);
                    const pos = slot.pos || "";
                    const isStarter = (_a = slot.isStarter) !== null && _a !== void 0 ? _a : false;
                    const isTaxi = (_b = slot.isTaxi) !== null && _b !== void 0 ? _b : false;
                    const name = slot.playerName || "";
                    if (isStarter && pos === "QB")
                        ts.qbPts += pts;
                    if (isStarter && pos !== "QB" && pts > ts.nonQbMax) {
                        ts.nonQbMax = pts;
                        ts.nonQbName = name;
                    }
                    if (!isStarter && !isTaxi) {
                        ts.benchPts += pts;
                        wBench += pts;
                    }
                    if (isTaxi)
                        ts.taxiPts += pts;
                    if (isStarter && pts < 0)
                        ts.negStarters++;
                    if (isStarter) {
                        ts.actualPts += pts;
                        wActual += pts;
                    }
                    if (isStarter && sd.won && pts > ts.gwpMax) {
                        ts.gwpMax = pts;
                        ts.gwpPlayer = name;
                    }
                });
                ts.optimalPts += wOptimal;
                ts.weekBench.push(wBench);
                ts.weekActual.push(wActual);
                ts.weekOptimal.push(wOptimal);
            });
        });
        ;
        const tsArr = Object.entries(teamStats).map(([name, v]) => ({ name, ...v }));
        const coachPct = t => t.optimalPts > 0 ? t.actualPts / t.optimalPts * 100 : 0;
        // QB Award: highest QB points
        const byQb = [...tsArr].sort((a, b) => b.qbPts - a.qbPts);
        if (((_s = byQb[0]) === null || _s === void 0 ? void 0 : _s.qbPts) > 0)
            awards[1] = { winner: byQb[0].name, value: byQb[0].qbPts, unit: "QB Pts", runnerUp: (_t = byQb[1]) === null || _t === void 0 ? void 0 : _t.name };
        // Non-QB Award
        const byNonQb = [...tsArr].sort((a, b) => b.nonQbMax - a.nonQbMax);
        if (((_u = byNonQb[0]) === null || _u === void 0 ? void 0 : _u.nonQbMax) > 0)
            awards[2] = { winner: byNonQb[0].name, value: byNonQb[0].nonQbMax, unit: "Pts", detail: byNonQb[0].nonQbName };
        // Game Winning Performance
        const byGwp = [...tsArr].sort((a, b) => b.gwpMax - a.gwpMax);
        if (((_v = byGwp[0]) === null || _v === void 0 ? void 0 : _v.gwpMax) > 0)
            awards[20] = { winner: byGwp[0].name, value: byGwp[0].gwpMax, unit: "Pts", detail: byGwp[0].gwpPlayer };
        // Peter Zwegat
        const byNeg = [...tsArr].sort((a, b) => b.negStarters - a.negStarters);
        if (((_w = byNeg[0]) === null || _w === void 0 ? void 0 : _w.negStarters) > 0)
            awards[21] = { winner: byNeg[0].name, value: byNeg[0].negStarters, unit: "neg. Starter" };
        // Bench Boss
        const byBench = [...tsArr].sort((a, b) => b.benchPts - a.benchPts);
        awards[22] = { winner: byBench[0].name, value: byBench[0].benchPts, unit: "Bench Pts" };
        // Best/Worst single-week bench
        const allWeekBench = tsArr.flatMap(t => t.weekBench.map((s, i) => ({ team: t.name, score: s, week: i + 1 })));
        if (allWeekBench.length) {
            const bwbMax = allWeekBench.reduce((a, b) => b.score > a.score ? b : a);
            const bwbMin = allWeekBench.filter(s => s.score > 0).reduce((a, b) => b.score < a.score ? b : a);
            awards[23] = { winner: bwbMax.team, value: bwbMax.score, unit: "Pts", detail: `W${bwbMax.week}` };
            awards[24] = { winner: bwbMin.team, value: bwbMin.score, unit: "Pts", detail: `W${bwbMin.week}` };
        }
        // Lineup Löwe / Bonobo
        const byCoach = [...tsArr].sort((a, b) => coachPct(b) - coachPct(a));
        if (((_x = byCoach[0]) === null || _x === void 0 ? void 0 : _x.optimalPts) > 0) {
            awards[25] = { winner: byCoach[0].name, value: coachPct(byCoach[0]).toFixed(1), unit: "%" };
            awards[26] = { winner: byCoach.at(-1).name, value: coachPct(byCoach.at(-1)).toFixed(1), unit: "%" };
        }
        // Best/Worst single-week lineup
        const weekPct = tsArr.flatMap(t => t.weekOptimal.map((opt, i) => ({
            team: t.name, week: i + 1,
            pct: opt > 0 ? t.weekActual[i] / opt * 100 : 0,
            actual: t.weekActual[i], opt
        }))).filter(x => x.opt > 0);
        if (weekPct.length) {
            const wpMax = weekPct.reduce((a, b) => b.pct > a.pct ? b : a);
            const wpMin = weekPct.reduce((a, b) => b.pct < a.pct ? b : a);
            awards[27] = { winner: wpMax.team, value: wpMax.pct.toFixed(0), unit: "%", detail: `W${wpMax.week} ${wpMax.actual.toFixed(1)}/${wpMax.opt.toFixed(1)}` };
            awards[28] = { winner: wpMin.team, value: wpMin.pct.toFixed(0), unit: "%", detail: `W${wpMin.week} ${wpMin.actual.toFixed(1)}/${wpMin.opt.toFixed(1)}` };
        }
        // Taxi Squad
        const byTaxi = [...tsArr].sort((a, b) => b.taxiPts - a.taxiPts);
        if (((_y = byTaxi[0]) === null || _y === void 0 ? void 0 : _y.taxiPts) > 0) {
            awards[29] = { winner: byTaxi[0].name, value: byTaxi[0].taxiPts, unit: "Pts" };
            awards[30] = { winner: byTaxi.at(-1).name, value: byTaxi.at(-1).taxiPts, unit: "Pts" };
        }
    }
    awards._raw = data; // reference for vote candidate generation
    return awards;
}
// ─── DATA LOADER ──────────────────────────────────────────────────────────────
const AWARDS_DEF = [
    { id: 1, name: "Always QB Award", icon: "🏈", cat: "scoring", method: "box", desc: "Team mit den meisten QB-Saisonpunkten" },
    { id: 2, name: "Non QB Points Award", icon: "⭐", cat: "scoring", method: "box", desc: "Team mit dem Top Nicht-QB Spieler" },
    { id: 3, name: "Free Agency Market Master", icon: "📈", cat: "moves", method: "tx", desc: "Meisten Adds über die Saison" },
    { id: 4, name: "Free Agency, was ist das?", icon: "😴", cat: "moves", method: "tx", desc: "Wenigsten Adds" },
    { id: 5, name: "Waiverhannes", icon: "📋", cat: "moves", method: "tx", desc: "Meisten Waiver-Claims" },
    { id: 6, name: "Drunken Claim", icon: "🍺", cat: "moves", method: "tx", desc: "Wenigsten Waiver-Claims" },
    { id: 7, name: "Money Mitch Award", icon: "💰", cat: "moves", method: "tx", desc: "Höchste Auktions-Gewinnquote %" },
    { id: 8, name: "Break the Bank", icon: "🏦", cat: "moves", method: "tx", desc: "Teuerster ersteigeter Spieler ($)" },
    { id: 9, name: "Trader des Jahres", icon: "🤝", cat: "moves", method: "tx", desc: "Meisten Trades" },
    { id: 10, name: "Faulenzer des Jahres", icon: "🛋️", cat: "moves", method: "tx", desc: "Wenigsten Trades" },
    { id: 11, name: "Condition Master", icon: "📝", cat: "moves", method: "check", desc: "Meisten Trades mit Bedingungen" },
    { id: 12, name: "Luckiest Owner", icon: "🍀", cat: "standings", method: "stand", desc: "Höchster Luck-Wert" },
    { id: 13, name: "Unluckiest Owner", icon: "💀", cat: "standings", method: "stand", desc: "Niedrigster Luck-Wert" },
    { id: 14, name: "Number One", icon: "🥇", cat: "standings", method: "stand", desc: "Meisten Regular Season Punkte" },
    { id: 15, name: "Number Eight", icon: "🥈", cat: "standings", method: "stand", desc: "Wenigsten Regular Season Punkte" },
    { id: 16, name: "Fiesta Mexicana", icon: "🎉", cat: "scoring", method: "sb", desc: "Höchster Score in einer Woche" },
    { id: 17, name: "Der Griff ins Klo", icon: "🚽", cat: "scoring", method: "sb", desc: "Niedrigster Score in einer Woche" },
    { id: 18, name: "Zerstörung", icon: "💥", cat: "scoring", method: "sb", desc: "Größte Siegdifferenz" },
    { id: 19, name: "One Inch Short", icon: "😭", cat: "scoring", method: "sb", desc: "Knappeste Niederlage" },
    { id: 20, name: "Game Winning Performance", icon: "🦸", cat: "scoring", method: "box", desc: "Spieler mit meisten Pts in einem Sieg" },
    { id: 21, name: "Peter Zwegat", icon: "📉", cat: "roster", method: "box", desc: "Meisten Starter mit < 0 Pts" },
    { id: 22, name: "Bench Boss", icon: "🪑", cat: "roster", method: "box", desc: "Meiste Bench-Punkte gesamt" },
    { id: 23, name: "Falsche Spieler gestartet?", icon: "🤦", cat: "roster", method: "box", desc: "Höchste Bench-Pts in einer Woche" },
    { id: 24, name: "Kader = nur Starter", icon: "🎯", cat: "roster", method: "box", desc: "Niedrigste Bench-Pts in einer Woche" },
    { id: 25, name: "Lineup Löwe", icon: "🦁", cat: "roster", method: "box", desc: "Beste Coach-Quote % gesamt" },
    { id: 26, name: "Lineup Bonobo", icon: "🦧", cat: "roster", method: "box", desc: "Schlechteste Coach-Quote %" },
    { id: 27, name: "Picked Perfect", icon: "✅", cat: "roster", method: "box", desc: "Bestes Lineup in einer Woche (%)" },
    { id: 28, name: "CHOSEN CATASTROPHY", icon: "❌", cat: "roster", method: "box", desc: "Schlechtestes Lineup in einer Woche" },
    { id: 29, name: "Taxi Squad King", icon: "🚕", cat: "roster", method: "box", desc: "Meiste Taxi-Squad-Punkte" },
    { id: 30, name: "Wo fährt das Taxi hin?", icon: "🚖", cat: "roster", method: "box", desc: "Wenigste Taxi-Squad-Punkte" },
    { id: 31, name: "Drop it like its hot", icon: "🤲", cat: "player", method: "check", desc: "Spieler mit meisten Drops" },
    { id: 32, name: "Inter des Jahres", icon: "🚨", cat: "player", method: "check", desc: "Gestarteter QB mit meisten INTs" },
    { id: 33, name: "MVP", icon: "🏆", cat: "vote", method: "vote", desc: "Bester Spieler der Saison" },
    { id: 34, name: "Rookie des Jahres", icon: "🌱", cat: "vote", method: "vote", desc: "Bester Rookie der Saison" },
    { id: 35, name: "Best FA Pick Up", icon: "👑", cat: "vote", method: "vote", desc: "Beste Free-Agent-Verpflichtung" },
    { id: 36, name: "Worst Drop", icon: "🗑️", cat: "vote", method: "vote", desc: "Schlechtester Drop" },
    { id: 37, name: "Trade des Jahres", icon: "🌟", cat: "vote", method: "vote", desc: "Bester Trade der Saison" },
    { id: 38, name: "Verlust des Jahres", icon: "😱", cat: "vote", method: "vote", desc: "Schlimmster Spielerverlust" },
    { id: 39, name: "Best Draft Pick", icon: "🎯", cat: "vote", method: "vote", desc: "Bester Draft-Pick" },
    { id: 40, name: "Worst Draft Pick", icon: "💸", cat: "vote", method: "vote", desc: "Schlechtester Draft-Pick" },
    { id: 41, name: "Einfach nur Madness", icon: "🤯", cat: "vote", method: "vote", desc: "Verrücktestes NFL-Ereignis" },
    { id: 42, name: "Greatest WHO?! Award", icon: "❓", cat: "vote", method: "vote", desc: "Unbekanntester Spieler mit Impact" },
    { id: 43, name: "Zitat des Jahres", icon: "💬", cat: "vote", method: "vote", desc: "Bestes Zitat der Saison" },
];
const CAT_COLORS = { scoring: "#facc15", moves: "#34d399", standings: "#60a5fa", roster: "#f472b6", player: "#fb923c", vote: "#a78bfa" };
const TEAM_PALETTE = ["#facc15", "#34d399", "#60a5fa", "#f472b6", "#fb923c", "#a78bfa", "#2dd4bf", "#f87171", "#86efac", "#fbbf24"];
// ─── MINI COMPONENTS ──────────────────────────────────────────────────────────
const Spinner = ({ sz = 18 }) => (React.createElement("span", { style: { display: "inline-block", width: sz, height: sz, flexShrink: 0,
        border: `${Math.max(2, sz / 6)}px solid #1e3a5f`, borderTopColor: "#facc15",
        borderRadius: "50%", animation: "spin 0.7s linear infinite" } }));
const Tag = ({ c = "#facc15", children }) => (React.createElement("span", { className: "text-xs px-2 py-0.5 rounded font-bold uppercase tracking-wider", style: { background: c + "22", color: c, border: `1px solid ${c}44` } }, children));
function FieldInput({ label, type = "text", value, onChange, placeholder, hint, autoFocus, onEnter }) {
    return (React.createElement("div", null,
        React.createElement("label", { className: "block text-xs font-bold uppercase tracking-widest mb-1.5", style: { color: "#475569" } }, label),
        React.createElement("input", { type: type, value: value, onChange: e => onChange(e.target.value), placeholder: placeholder, autoFocus: autoFocus, onKeyDown: e => e.key === "Enter" && (onEnter === null || onEnter === void 0 ? void 0 : onEnter()), className: "w-full rounded-xl px-4 py-3 text-sm text-white outline-none", style: { background: "#0b1929", border: "1px solid #1e3a5f", fontFamily: "inherit", transition: "border-color .15s" }, onFocus: e => e.target.style.borderColor = "#facc1566", onBlur: e => e.target.style.borderColor = "#1e3a5f" }),
        hint && React.createElement("p", { className: "text-xs mt-1.5", style: { color: "#374151" } }, hint)));
}
function ConnectBtn({ onClick, disabled, loading, children, full, small }) {
    return (React.createElement("button", { onClick: onClick, disabled: disabled || loading, className: `${full ? "w-full" : ""} flex items-center justify-center gap-2 rounded-xl font-black transition-all disabled:opacity-30 hover:brightness-110`, style: { background: "linear-gradient(135deg,#facc15,#f59e0b)", color: "#000",
            padding: small ? ".5rem 1rem" : ".75rem 1.25rem", fontSize: small ? ".75rem" : ".875rem" } },
        loading && React.createElement(Spinner, { sz: 14 }),
        " ",
        children));
}
function StatusMsg({ status }) {
    if (!(status === null || status === void 0 ? void 0 : status.msg))
        return null;
    const m = { ok: ["#052e16", "#4ade80", "#166534"], error: ["#450a0a", "#fca5a5", "#7f1d1d"], info: ["#0c1f38", "#93c5fd", "#1e3a5f"] };
    const [bg, fg, br] = m[status.type] || m.info;
    return (React.createElement("div", { className: "rounded-xl px-4 py-3 text-xs font-medium flex items-start gap-2", style: { background: bg, color: fg, border: `1px solid ${br}` } },
        React.createElement("span", { className: "flex-shrink-0" }, status.type === "ok" ? "✓" : status.type === "error" ? "⚠" : "ℹ"),
        React.createElement("span", { style: { whiteSpace: "pre-line" } }, status.msg)));
}
// ─── PROGRESS BAR ─────────────────────────────────────────────────────────────
function ProgressBar({ steps, current }) {
    return (React.createElement("div", { className: "space-y-2" }, steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        const c = done ? "#4ade80" : active ? "#facc15" : "#1e3a5f";
        return (React.createElement("div", { key: i, className: "flex items-center gap-3" },
            React.createElement("div", { className: "flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-black", style: { background: done ? "#052e16" : active ? "#facc1522" : "#0b1929", border: `1.5px solid ${c}` } }, done ? React.createElement("span", { style: { color: "#4ade80" } }, "\u2713") : active ? React.createElement(Spinner, { sz: 12 }) : React.createElement("span", { style: { color: "#1e3a5f" } }, i + 1)),
            React.createElement("div", { className: "flex-1" },
                React.createElement("div", { className: "text-xs font-bold", style: { color: c } }, s.label),
                active && s.detail && React.createElement("div", { className: "text-xs mt-0.5", style: { color: "#475569" } }, s.detail)),
            done && React.createElement("span", { className: "text-xs font-mono", style: { color: "#4ade8066" } }, s.count || "")));
    })));
}
// ─── LOGIN SCREEN ─────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
    const [tab, setTab] = useState("cookie"); // default: cookie tab
    const [userInput, setUserInput] = useState("MTE1MTM0NHw0ODNCQ0YyOUJCQkU1MTY0NjRDMTNCQUFDRDVCODhEMQ=="); // pre-filled cookie
    const [loading, setLoading] = useState(false);
    const [proxyOk, setProxyOk] = useState(null);
    const [status, setStatus] = useState({ type: "", msg: "" });
    const [phase, setPhase] = useState("creds");
    const [userId, setUserId] = useState("");
    const [leagues, setLeagues] = useState([]);
    const [selLeague, setSelLeague] = useState(null);
    const [season, setSeason] = useState(String(new Date().getFullYear() - 1));
    const [manualId, setManualId] = useState(() => {
    const id = localStorage.getItem('ff_intent_league') || "";
    if (id) localStorage.removeItem('ff_intent_league');
    return id;
  });
    const [loadingLeague, setLoadingLeague] = useState(false);
    const log = (type, msg) => setStatus({ type, msg });
    useEffect(() => { setProxyOk(true); }, []);
    const handleConnect = async () => {
        const raw = userInput.trim();
        if (!raw) {
            log("error", "Bitte Wert eingeben.");
            return;
        }
        setLoading(true);
        log("info", "Verarbeite…");
        let uid = null;
        if (tab === "userid") {
            uid = parseUserId(raw);
            if (!uid) {
                log("error", "Keine gültige User-ID.\nBeispiel: 12345 oder fleaflicker.com/nfl/users/12345");
                setLoading(false);
                return;
            }
        }
        else {
            uid = userIdFromCookie(raw);
            if (!uid) {
                log("info", "userId nicht im Cookie. Bitte User-ID-Methode oder Liga-ID manuell.");
                setUserId("");
                setLeagues([]);
                setPhase("league");
                setLoading(false);
                return;
            }
            log("info", `userId ${uid} aus Cookie.`);
        }
        setUserId(uid);
        // Persist userId for later (e.g. QuickSwitcher)
        localStorage.setItem("ff_uid", uid);
        try {
            const found = await fetchLeaguesByUserId(uid);
            log(found.length ? "ok" : "info", found.length ? `${found.length} Liga(en) gefunden.` : "Keine Ligen — Liga-ID manuell eingeben.");
            setLeagues(found);
            // Persist leagues for QuickSwitcher
            localStorage.setItem("ff_leagues", JSON.stringify(found));
            if (found.length) {
                setSelLeague(found[0]);
                setSeason(String(found[0].season));
            }
            setPhase("league");
        }
        catch (e) {
            log("error", "Fehler: " + e.message);
        }
        setLoading(false);
    };
    const handleManualLoad = async () => {
        if (!manualId.trim())
            return;
        const fake = { id: manualId.trim(), name: `Liga ${manualId.trim()}`, season: +season };
        setSelLeague(fake);
        log("info", `Liga ${fake.id} ausgewählt.`);
    };
    const handleEnter = () => {
        if (!selLeague)
            return;
        onLogin({ leagueId: selLeague.id, season: +season });
    };
    return (React.createElement("div", { className: "min-h-screen flex items-center justify-center p-4", style: { background: "radial-gradient(ellipse at 30% 20%, #0d2040 0%, #040a12 70%)" } },
        React.createElement("div", { className: "w-full max-w-md" },
            React.createElement("div", { className: "text-center mb-8" },
                React.createElement("div", { className: "text-5xl mb-2" }, "\uD83C\uDFC8"),
                React.createElement("h1", { className: "text-4xl font-black tracking-tighter text-white" }, "AWARDS HQ"),
                React.createElement("p", { className: "text-xs mt-1.5 font-mono tracking-widest uppercase", style: { color: "#374151" } }, "Fleaflicker Dynasty Platform"),
                React.createElement("div", { className: "mt-3 inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold", style: { background: proxyOk === null ? "#0f1f38" : proxyOk ? "#052e1688" : "#450a0a88",
                        color: proxyOk === null ? "#475569" : proxyOk ? "#4ade80" : "#f87171",
                        border: `1px solid ${proxyOk === null ? "#1e3a5f" : proxyOk ? "#166534" : "#7f1d1d"}` } },
                    React.createElement("span", { style: { width: 6, height: 6, borderRadius: "50%", display: "inline-block", flexShrink: 0,
                            background: proxyOk === null ? "#475569" : proxyOk ? "#4ade80" : "#f87171",
                            animation: proxyOk === null ? "spin 1.5s linear infinite" : "none" } }),
                    proxyOk === null ? "Prüfe API-Verbindung…" : proxyOk ? "API erreichbar ✓" : "Proxy offline — trotzdem versuchen")),
            phase === "creds" && (React.createElement("div", { className: "rounded-2xl border border-slate-800 overflow-hidden", style: { background: "#080f1a" } },
                React.createElement("div", { className: "flex border-b border-slate-800" }, [["userid", "🆔 User-ID"], ["cookie", "🍪 Cookie"]].map(([id, label]) => (React.createElement("button", { key: id, onClick: () => { setTab(id); setStatus({ type: "", msg: "" }); setUserInput(id === "cookie" ? "MTE1MTM0NHw0ODNCQ0YyOUJCQkU1MTY0NjRDMTNCQUFDRDVCODhEMQ==" : ""); }, className: "flex-1 py-3.5 text-sm font-black transition-all", style: { background: tab === id ? "#0d1f38" : "transparent", color: tab === id ? "#facc15" : "#475569",
                        borderBottom: tab === id ? "2px solid #facc15" : "2px solid transparent" } }, label)))),
                React.createElement("div", { className: "p-6 space-y-4" },
                    tab === "userid" && (React.createElement(React.Fragment, null,
                        React.createElement("div", { className: "rounded-xl p-4 border border-slate-700 space-y-2.5", style: { background: "#0b1525" } }, [["1", React.createElement(React.Fragment, null,
                                    "\u00D6ffne ",
                                    React.createElement("a", { href: "https://www.fleaflicker.com", target: "_blank", rel: "noreferrer", className: "underline", style: { color: "#facc15" } }, "fleaflicker.com"),
                                    " und logge dich ein.")],
                            ["2", React.createElement(React.Fragment, null,
                                    "Klicke oben rechts auf deinen ",
                                    React.createElement("strong", { className: "text-white" }, "Benutzernamen"),
                                    ".")],
                            ["3", React.createElement(React.Fragment, null,
                                    "URL: ",
                                    React.createElement("code", { className: "px-1 rounded text-xs", style: { background: "#1e3a5f", color: "#93c5fd" } },
                                        "fleaflicker.com/nfl/users/",
                                        React.createElement("strong", { style: { color: "#facc15" } }, "12345")),
                                    " \u2014 diese Zahl kopieren.")],
                        ].map(([n, t]) => (React.createElement("div", { key: n, className: "flex gap-2.5 items-start" },
                            React.createElement("div", { className: "flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-black mt-0.5", style: { background: "#facc15", color: "#000" } }, n),
                            React.createElement("div", { className: "text-xs text-slate-300 leading-relaxed" }, t))))),
                        React.createElement(FieldInput, { label: "Fleaflicker User-ID oder Profil-URL", value: userInput, onChange: setUserInput, placeholder: "12345  oder  fleaflicker.com/nfl/users/12345", hint: "Funktioniert f\u00FCr \u00F6ffentliche und private Ligen.", autoFocus: true, onEnter: handleConnect }))),
                    tab === "cookie" && (React.createElement(React.Fragment, null,
                        React.createElement("div", { className: "rounded-xl p-4 border border-slate-700 space-y-2.5", style: { background: "#0b1525" } }, [["1", React.createElement(React.Fragment, null,
                                    "\u00D6ffne ",
                                    React.createElement("a", { href: "https://www.fleaflicker.com", target: "_blank", rel: "noreferrer", className: "underline", style: { color: "#facc15" } }, "fleaflicker.com"),
                                    " und logge dich ein.")],
                            ["2", React.createElement(React.Fragment, null,
                                    React.createElement("code", { className: "px-1 rounded text-xs", style: { background: "#1e3a5f", color: "#93c5fd" } }, "F12"),
                                    " \u2192 ",
                                    React.createElement("strong", { className: "text-white" }, "Chrome:"),
                                    " Application \u2192 Cookies \u2192 fleaflicker.com",
                                    React.createElement("br", null),
                                    React.createElement("strong", { className: "text-white" }, "Firefox:"),
                                    " Storage \u2192 Cookies \u2192 fleaflicker.com")],
                            ["3", React.createElement(React.Fragment, null,
                                    "Cookie ",
                                    React.createElement("code", { className: "px-1.5 py-0.5 rounded text-xs font-bold", style: { background: "#facc1520", color: "#facc15", border: "1px solid #facc1540" } }, "FleaFlicker"),
                                    " \u2192 ",
                                    React.createElement("strong", { className: "text-white" }, "Value"),
                                    " kopieren.")],
                        ].map(([n, t]) => (React.createElement("div", { key: n, className: "flex gap-2.5 items-start" },
                            React.createElement("div", { className: "flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-black mt-0.5", style: { background: "#facc15", color: "#000" } }, n),
                            React.createElement("div", { className: "text-xs text-slate-300 leading-relaxed" }, t))))),
                        React.createElement(FieldInput, { label: "FleaFlicker Cookie-Wert", value: userInput, onChange: setUserInput, placeholder: "langer base64 Wert\u2026", hint: "Der Wert des FleaFlicker-Cookies.", onEnter: handleConnect }))),
                    React.createElement(ConnectBtn, { onClick: handleConnect, loading: loading, full: true }, "Weiter \u2192"),
                    React.createElement(StatusMsg, { status: status })))),
            phase === "league" && (React.createElement("div", { className: "rounded-2xl border border-slate-800 overflow-hidden", style: { background: "#080f1a" } },
                React.createElement("div", { className: "px-5 pt-4 pb-3 border-b border-slate-800 flex items-center justify-between" },
                    React.createElement("div", { className: "flex items-center gap-2" },
                        React.createElement("span", { style: { color: "#4ade80" } }, "\u2713"),
                        React.createElement("span", { className: "text-white font-bold text-sm" }, "Liga ausw\u00E4hlen"),
                        userId && React.createElement("span", { className: "text-xs font-mono", style: { color: "#374151" } },
                            "uid:",
                            userId)),
                    React.createElement("button", { onClick: () => { setPhase("creds"); setLeagues([]); setSelLeague(null); setStatus({ type: "", msg: "" }); }, className: "text-xs hover:text-slate-400 transition-colors", style: { color: "#374151" } }, "\u2190 zur\u00FCck")),
                React.createElement("div", { className: "p-5 space-y-4" },
                    leagues.length > 0 && (React.createElement("div", null,
                        React.createElement("label", { className: "block text-xs font-bold uppercase tracking-widest mb-2", style: { color: "#475569" } }, "Deine Ligen"),
                        React.createElement("div", { className: "space-y-1.5 max-h-44 overflow-y-auto pr-1" }, leagues.map(l => (React.createElement("button", { key: l.id, onClick: () => { setSelLeague(l); setSeason(String(l.season)); }, className: "w-full text-left px-4 py-2.5 rounded-xl border transition-all", style: { background: (selLeague === null || selLeague === void 0 ? void 0 : selLeague.id) === l.id ? "#facc1512" : "#0b1525",
                                borderColor: (selLeague === null || selLeague === void 0 ? void 0 : selLeague.id) === l.id ? "#facc15" : "#1e3a5f",
                                color: (selLeague === null || selLeague === void 0 ? void 0 : selLeague.id) === l.id ? "#facc15" : "#cbd5e1" } },
                            React.createElement("div", { className: "text-sm font-bold" },
                                (selLeague === null || selLeague === void 0 ? void 0 : selLeague.id) === l.id && "✓ ",
                                l.name),
                            React.createElement("div", { className: "text-xs mt-0.5", style: { color: "#475569" } },
                                "ID ",
                                l.id,
                                " \u00B7 Saison ",
                                l.season))))))),
                    React.createElement("div", null,
                        React.createElement("label", { className: "block text-xs font-bold uppercase tracking-widest mb-2", style: { color: "#475569" } }, leagues.length > 0 ? "Andere Liga-ID" : "Liga-ID manuell"),
                        React.createElement("div", { className: "flex gap-2" },
                            React.createElement("input", { className: "flex-1 rounded-xl px-3 py-2.5 text-sm text-white outline-none", style: { background: "#0b1929", border: "1px solid #1e3a5f", fontFamily: "inherit" }, placeholder: "z.B. 297091", value: manualId, onChange: e => setManualId(e.target.value), onKeyDown: e => e.key === "Enter" && handleManualLoad(), onFocus: e => e.target.style.borderColor = "#facc1566", onBlur: e => e.target.style.borderColor = "#1e3a5f" }),
                            React.createElement(ConnectBtn, { onClick: handleManualLoad, loading: loadingLeague, small: true }, "Laden")),
                        React.createElement("p", { className: "text-xs mt-1.5", style: { color: "#1e3a5f" } },
                            "fleaflicker.com/nfl/leagues/",
                            React.createElement("strong", { style: { color: "#334155" } }, "ID"))),
                    selLeague && (React.createElement("div", null,
                        React.createElement("label", { className: "block text-xs font-bold uppercase tracking-widest mb-2", style: { color: "#475569" } }, "Saison"),
                        React.createElement("select", { className: "w-full rounded-xl px-4 py-2.5 text-sm text-white outline-none", style: { background: "#0b1929", border: "1px solid #1e3a5f", fontFamily: "inherit" }, value: season, onChange: e => setSeason(e.target.value) }, [2028, 2027, 2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018].map(y => React.createElement("option", { key: y, value: y }, y))))),
                    React.createElement(StatusMsg, { status: status }),
                    React.createElement(ConnectBtn, { onClick: handleEnter, disabled: !selLeague, full: true }, "Liga laden \u2192")))))));
}
// ─── VOTING PANEL ─────────────────────────────────────────────────────────────
const VOTE_CANDIDATES = {
    33: ["Lamar Jackson", "Josh Allen", "Saquon Barkley", "Ja'Marr Chase", "CeeDee Lamb", "Brock Bowers"],
    34: ["Jayden Daniels", "Bucky Irving", "Malik Nabers", "Brian Thomas Jr.", "Brock Bowers"],
    35: ["Devaughn Vele", "Sam Darnold", "Jameis Winston", "Jordan Mason", "Kayshon Boutte"],
    36: ["Devaughn Vele", "KJ Osborn", "Sean Tucker"],
    37: ["Achane Trade", "Derrick Henry Trade", "Jonathan Taylor Trade", "James Cook Trade"],
    38: ["Dak Prescott", "Christian McCaffrey", "Chris Godwin", "Aaron Rodgers"],
    39: ["Tyrone Tracy", "Bucky Irving", "Jalen McMillan", "Ladd McConkey", "Bo Nix"],
    40: ["Caleb Williams", "Jonathan Brooks", "Trey Benson", "Jermaine Burton"],
    41: ["Ricky Pearsall Shooting", "Washington Hail Mary vs Bears", "Barkley Backwards Jump", "Tyreek Hill Verhaftung"],
    42: ["Blake Whiteheart", "Tyrell Shavers", "Tay Martin", "Nikko Remigio", "Nate Adkins"],
    43: ["Bourks und Johnson (Tim)", "Xavier Worthy (Younes)", "Der Mann mit Reis (Max)", "Anonymer Ameisenbär (Max)", "Avatar Stevenson (Thomas)"],
};
function VotingPanel({ award, session, liveData }) {
    const [votes, setVotes] = useState({});
    const [myTeam, setMyTeam] = useState(() => localStorage.getItem("ff_my_team_" + session.leagueId) || "");
    const [askTeam, setAskTeam] = useState(false);
    const [custom, setCustom] = useState("");
    const [tradeFilter, setTradeFilter] = useState("");
    const key = `votes:${session.leagueId}:${award.id}`;
    // Build dynamic candidate list from live data for relevant awards
    const buildCandidates = () => {
        const base = VOTE_CANDIDATES[award.id] || [];
        const trades = (liveData === null || liveData === void 0 ? void 0 : liveData.trades) || [];
        const txs = (liveData === null || liveData === void 0 ? void 0 : liveData.transactions) || [];
        if (award.id === 37 || award.id === 11) {
            // Trade des Jahres / Condition Master: generate from actual trades
            const tradeLabels = trades.reduce((acc, t) => {
                // One label per unique trade (group by tradeId+partner)
                const key2 = `${t.tradeId}`;
                if (acc.find(x => x.key === key2))
                    return acc;
                const recv = t.received.map(p => p.name).join(", ") || "?";
                const sent = t.sent.map(p => p.name).join(", ") || "?";
                const picks = [...t.picksReceived, ...t.picksSent].join(", ");
                const label = `${t.teamName.split(" ").pop()} ↔ ${t.partner.split(" ").pop()}: ${recv}${picks ? " + " + picks : ""}`;
                acc.push({ key: key2, label, epochMs: t.epochMs, recv, sent, pts: t.received.reduce((s, p) => s + (p.pts || 0), 0) });
                return acc;
            }, []);
            // Sort by value descending
            tradeLabels.sort((a, b) => b.pts - a.pts);
            return [...new Set([...tradeLabels.map(t => t.label), ...base])].slice(0, 15);
        }
        if (award.id === 35) {
            // Best FA Pick Up: top adds by season points
            const adds = txs.filter(t => t.type === "ADD" && t.playerAdded)
                .sort((a, b) => 0) // can't sort by pts without player lookup
                .map(t => `${t.playerAdded} (${t.teamName.split(" ").pop()})`)
                .filter((v, i, a) => a.indexOf(v) === i).slice(0, 12);
            return [...adds, ...base].filter((v, i, a) => a.indexOf(v) === i).slice(0, 15);
        }
        if (award.id === 36) {
            // Worst Drop
            const drops = txs.filter(t => t.type === "DROP" && t.playerDropped)
                .map(t => `${t.playerDropped} (${t.teamName.split(" ").pop()})`)
                .filter((v, i, a) => a.indexOf(v) === i).slice(0, 12);
            return [...drops, ...base].filter((v, i, a) => a.indexOf(v) === i).slice(0, 15);
        }
        if (award.id === 33) {
            // MVP: top scorers from standings
            const topPlayers = ((liveData === null || liveData === void 0 ? void 0 : liveData.standings) || [])
                .sort((a, b) => b.pointsFor - a.pointsFor)
                .map(t => t.name).slice(0, 6);
            return [...base.filter(b => !topPlayers.includes(b)), ...topPlayers].slice(0, 12);
        }
        return base;
    };
    const opts = buildCandidates();
    useEffect(() => {
        let t;
        const load = async () => {
            const v = await storageGet(key);
            if (v === null || v === void 0 ? void 0 : v.value) {
                try {
                    const d = JSON.parse(v.value);
                    setVotes(d.ballots || {});
                }
                catch { }
            }
        };
        load();
        t = setInterval(load, 5000);
        return () => clearInterval(t);
    }, [key]);
    const castVote = async (opt, team) => {
        const updated = { ...votes, [team]: opt };
        setVotes(updated);
        await storageSet(key, JSON.stringify({ ballots: updated }));
    };
    const handleVote = (opt) => {
        if (!myTeam) {
            setAskTeam(true);
            return;
        }
        castVote(opt, myTeam);
    };
    const tally = Object.values(votes).reduce((a, v) => { a[v] = (a[v] || 0) + 1; return a; }, {});
    const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    const total = Object.keys(votes).length;
    if (askTeam) {
        const teams = JSON.parse(localStorage.getItem(`ff_teams_${session.leagueId}`) || "[]");
        return (React.createElement("div", { className: "space-y-3" },
            React.createElement("p", { className: "text-xs font-bold text-white" }, "W\u00E4hle dein Team zum Abstimmen:"),
            React.createElement("div", { className: "space-y-1.5 max-h-52 overflow-y-auto" }, teams.map(t => (React.createElement("button", { key: t, onClick: () => { setMyTeam(t); localStorage.setItem("ff_my_team_" + session.leagueId, t); setAskTeam(false); }, className: "w-full text-left px-4 py-2.5 rounded-xl border text-sm font-medium transition-all", style: { background: "#0b1525", borderColor: "#1e3a5f", color: "#cbd5e1" } }, t)))),
            React.createElement("button", { onClick: () => setAskTeam(false), className: "text-xs text-slate-600" }, "\u2190 Abbrechen")));
    }
    const myVote = votes[myTeam] || "";
    return (React.createElement("div", { className: "space-y-4" },
        myTeam && (React.createElement("div", { className: "flex items-center justify-between" },
            React.createElement("p", { className: "text-xs text-slate-500" },
                "Abstimmen als ",
                React.createElement("span", { className: "text-white font-bold" }, myTeam)),
            React.createElement("button", { onClick: () => setAskTeam(true), className: "text-xs underline", style: { color: "#475569" } }, "wechseln"))),
        !myTeam && (React.createElement("button", { onClick: () => setAskTeam(true), className: "w-full py-2.5 rounded-xl border text-sm font-bold text-center", style: { background: "#facc1512", borderColor: "#facc1544", color: "#facc15" } }, "Team w\u00E4hlen um abzustimmen \u2192")),
        sorted.length > 0 && (React.createElement("div", { className: "rounded-xl p-4 border border-slate-800", style: { background: "#070d18" } },
            React.createElement("div", { className: "flex justify-between items-center mb-3" },
                React.createElement("span", { className: "text-xs font-black uppercase tracking-widest text-slate-500" }, "Live-Ergebnis"),
                React.createElement("span", { className: "text-xs text-slate-600 font-mono" },
                    total,
                    " Stimme",
                    total !== 1 ? "n" : "")),
            sorted.map(([opt, cnt], i) => (React.createElement("div", { key: opt, className: "mb-2" },
                React.createElement("div", { className: "flex justify-between text-xs mb-1" },
                    React.createElement("span", { className: "text-white font-medium" },
                        i === 0 ? "🏆 " : "",
                        opt),
                    React.createElement("span", { className: "font-mono text-slate-500" },
                        cnt,
                        "/",
                        total)),
                React.createElement("div", { className: "h-1.5 rounded-full overflow-hidden", style: { background: "#1e3a5f" } },
                    React.createElement("div", { className: "h-full rounded-full transition-all duration-700", style: { width: `${cnt / total * 100}%`, background: i === 0 ? "#facc15" : "#334155" } }))))))),
        opts.length > 5 && (React.createElement("input", { className: "w-full rounded-xl px-3 py-2 text-sm text-white outline-none mb-1", style: { background: "#0b1929", border: "1px solid #1e3a5f", fontFamily: "inherit" }, placeholder: "Suchen / filtern\u2026", value: tradeFilter, onChange: e => setTradeFilter(e.target.value) })),
        React.createElement("div", { className: "space-y-1.5 max-h-64 overflow-y-auto pr-1" },
            opts.filter(o => !tradeFilter || o.toLowerCase().includes(tradeFilter.toLowerCase())).map(opt => {
                const sel = myVote === opt;
                return (React.createElement("button", { key: opt, onClick: () => handleVote(opt), className: "w-full text-left px-4 py-2.5 rounded-xl border text-sm font-medium transition-all", style: { background: sel ? "#facc1512" : "#0b1525", borderColor: sel ? "#facc15" : "#1e3a5f", color: sel ? "#facc15" : "#cbd5e1" } },
                    sel && "✓ ",
                    opt));
            }),
            React.createElement("div", { className: "flex gap-2 pt-1" },
                React.createElement("input", { className: "flex-1 rounded-xl px-3 py-2 text-sm text-white outline-none", style: { background: "#0b1929", border: "1px solid #facc1566", fontFamily: "inherit" }, value: custom, onChange: e => setCustom(e.target.value), placeholder: "Eigener Vorschlag eingeben\u2026", onKeyDown: e => e.key === "Enter" && custom.trim() && (handleVote(custom.trim()), setCustom("")) }),
                React.createElement("button", { onClick: () => { if (custom.trim()) {
                        handleVote(custom.trim());
                        setCustom("");
                    } }, disabled: !custom.trim(), className: "px-3 py-2 rounded-xl font-bold text-xs disabled:opacity-30", style: { background: "#facc15", color: "#000" } }, "\u2713"))),
        Object.keys(votes).length > 0 && (React.createElement("div", { className: "rounded-xl p-3 border border-slate-800", style: { background: "#070d18" } },
            React.createElement("p", { className: "text-xs text-slate-600 mb-2 uppercase tracking-widest font-bold" }, "Stimmen"),
            React.createElement("div", { className: "flex flex-wrap gap-1.5" }, Object.entries(votes).map(([team, v]) => (React.createElement("div", { key: team, className: "text-xs px-2 py-1 rounded-lg", style: { background: "#1a2a40" } },
                React.createElement("span", { className: "text-slate-500" },
                    team.split(" ").slice(-1)[0],
                    ":"),
                " ",
                React.createElement("span", { className: "text-white font-medium" }, v)))))))));
}
// ─── SVG CHARTS ───────────────────────────────────────────────────────────────
function SvgBarChart({ data, dataKey, nameKey = "name", height = 220, getCellColor, getCellOpacity }) {
    if (!(data === null || data === void 0 ? void 0 : data.length))
        return React.createElement("div", { className: "text-center text-slate-700 py-8 text-xs" }, "Keine Daten");
    const vals = data.map(d => +d[dataKey] || 0), maxV = Math.max(...vals, 1), minV = Math.min(...vals), range = maxV - Math.min(minV, 0) || 1;
    const W = 500, pL = 36, pR = 8, pT = 8, pB = 36, cW = W - pL - pR, cH = height - pT - pB;
    const bw = Math.max(4, cW / data.length * 0.65), gap = cW / data.length;
    const y0 = pT + cH * (1 - Math.max(0, -minV) / (range || 1));
    return (React.createElement("svg", { viewBox: `0 0 ${W} ${height}`, width: "100%", style: { overflow: "visible" } },
        [0, .25, .5, .75, 1].map(t => {
            const yg = pT + cH * (1 - t), v = minV + range * t;
            return React.createElement("g", { key: t },
                React.createElement("line", { x1: pL, x2: W - pR, y1: yg, y2: yg, stroke: "#0d1f38", strokeDasharray: "3 3" }),
                React.createElement("text", { x: pL - 4, y: yg + 4, textAnchor: "end", fill: "#475569", fontSize: 9 }, v.toFixed(0)));
        }),
        React.createElement("line", { x1: pL, x2: W - pR, y1: y0, y2: y0, stroke: "#1e3a5f", strokeWidth: 1 }),
        data.map((d, i) => {
            const v = +d[dataKey] || 0, x = pL + gap * i + (gap - bw) / 2, barH = Math.abs(v / (range || 1)) * cH, y = v >= 0 ? y0 - barH : y0;
            const fill = getCellColor ? getCellColor(d) : "#facc15", op = getCellOpacity ? getCellOpacity(d) : 0.85;
            const label = String(d[nameKey] || "").slice(0, 7);
            return React.createElement("g", { key: i },
                React.createElement("rect", { x: x, y: y, width: bw, height: Math.max(2, barH), fill: fill, opacity: op, rx: 2 }),
                React.createElement("text", { x: x + bw / 2, y: height - pB + 14, textAnchor: "middle", fill: "#475569", fontSize: 9, transform: `rotate(-35,${x + bw / 2},${height - pB + 14})` }, label),
                React.createElement("text", { x: x + bw / 2, y: y - 3, textAnchor: "middle", fill: fill, fontSize: 8, fontWeight: "bold" }, Math.abs(v) > 0 ? (Math.abs(v) < 10 ? v.toFixed(1) : v.toFixed(0)) : ""));
        })));
}
function SvgLineChart({ data, nameKey = "week", lines = [], height = 220 }) {
    if (!(data === null || data === void 0 ? void 0 : data.length))
        return React.createElement("div", { className: "text-center text-slate-700 py-8 text-xs" }, "Keine Daten");
    const allVals = data.flatMap(d => lines.map(l => +d[l.k] || 0));
    const maxV = Math.max(...allVals, 1), minV = Math.min(...allVals, 0), range = maxV - minV || 1;
    const W = 500, pL = 36, pR = 8, pT = 8, pB = 20, cW = W - pL - pR, cH = height - pT - pB;
    const xStep = cW / Math.max(data.length - 1, 1);
    const toX = i => pL + i * xStep, toY = v => pT + cH * (1 - (v - minV) / range);
    return (React.createElement("svg", { viewBox: `0 0 ${W} ${height}`, width: "100%", style: { overflow: "visible" } },
        [0, .25, .5, .75, 1].map(t => {
            const yg = pT + cH * (1 - t), v = minV + range * t;
            return React.createElement("g", { key: t },
                React.createElement("line", { x1: pL, x2: W - pR, y1: yg, y2: yg, stroke: "#0d1f38", strokeDasharray: "3 3" }),
                React.createElement("text", { x: pL - 4, y: yg + 4, textAnchor: "end", fill: "#475569", fontSize: 9 }, v.toFixed(0)));
        }),
        data.map((d, i) => React.createElement("text", { key: i, x: toX(i), y: height - 4, textAnchor: "middle", fill: "#475569", fontSize: 9 }, String(d[nameKey] || ""))),
        lines.map((l, li) => {
            const pts = data.map((d, i) => toX(i) + "," + toY(+d[l.k] || 0)).join(" ");
            return React.createElement("g", { key: li },
                React.createElement("polyline", { points: pts, fill: "none", stroke: l.color, strokeWidth: l.w || 2, strokeDasharray: l.dash || "none", opacity: 0.9 }),
                data.map((d, i) => React.createElement("circle", { key: i, cx: toX(i), cy: toY(+d[l.k] || 0), r: 3, fill: l.color, opacity: 0.9 })));
        })));
}
// ─── AWARDS PAGE ──────────────────────────────────────────────────────────────
function AwardsPage({ data, session }) {
    var _a, _b;
    const liveData = data;
    const [catFilter, setCatFilter] = useState("all");
    const [selected, setSelected] = useState(AWARDS_DEF[0]);
    const awards = (data === null || data === void 0 ? void 0 : data.awards) || {};
    const cats = ["all", "scoring", "moves", "standings", "roster", "player", "vote"];
    const catLabel = { all: "Alle", scoring: "Scoring", moves: "Moves", standings: "Standings", roster: "Roster", player: "Spieler", vote: "Vote" };
    const filtered = AWARDS_DEF.filter(a => catFilter === "all" || a.cat === catFilter);
    return (React.createElement("div", { className: "flex", style: { height: "calc(100vh - 57px)" } },
        React.createElement("div", { className: "w-64 flex-shrink-0 border-r border-slate-800 flex flex-col overflow-hidden", style: { background: "#070d18" } },
            React.createElement("div", { className: "p-2 border-b border-slate-800 flex flex-wrap gap-1" }, cats.map(c => (React.createElement("button", { key: c, onClick: () => setCatFilter(c), className: "text-xs px-2 py-1 rounded font-bold transition-all", style: { background: catFilter === c ? (c === "all" ? "#facc15" : CAT_COLORS[c] || "#facc15") : "transparent",
                    color: catFilter === c ? "#000" : "#475569" } }, catLabel[c])))),
            React.createElement("div", { className: "flex-1 overflow-y-auto" }, filtered.map(a => {
                const result = awards[a.id];
                const sel = (selected === null || selected === void 0 ? void 0 : selected.id) === a.id;
                const methodColors = { box: "#60a5fa", tx: "#34d399", stand: "#facc15", sb: "#f472b6", vote: "#a78bfa", check: "#fb923c" };
                return (React.createElement("button", { key: a.id, onClick: () => setSelected(a), className: "w-full text-left px-3 py-2.5 border-b flex items-center gap-2.5 transition-all", style: { borderBottomColor: "#0d1a2e", background: sel ? "#0d1f38" : "transparent",
                        borderLeft: `3px solid ${sel ? CAT_COLORS[a.cat] : "transparent"}` } },
                    React.createElement("span", { className: "text-base flex-shrink-0" }, a.icon),
                    React.createElement("div", { className: "flex-1 min-w-0" },
                        React.createElement("div", { className: "text-xs font-bold text-white truncate" }, a.name),
                        result && React.createElement("div", { className: "text-xs text-slate-400 truncate" }, result.winner),
                        !result && a.method === "vote" && React.createElement("div", { className: "text-xs", style: { color: "#a78bfa" } }, "Abstimmen"),
                        !result && a.method !== "vote" && (React.createElement("div", { className: "text-xs", style: { color: methodColors[a.method] || "#475569" } }, a.method === "box" ? "Boxscores nötig" : a.method === "check" ? "Manuell" : a.method === "sb" ? "Scoreboard" : ""))),
                    result && (React.createElement("div", { className: "w-2 h-2 rounded-full flex-shrink-0 flex-shrink-0", style: { background: result.quality === "ok" ? "#4ade80" : result.quality === "warn" ? "#facc15" : result.quality === "low" ? "#f87171" : CAT_COLORS[a.cat] } }))));
            }))),
        React.createElement("div", { className: "flex-1 overflow-y-auto p-6" }, selected && (React.createElement(React.Fragment, null,
            React.createElement("div", { className: "flex items-start gap-4 mb-5" },
                React.createElement("span", { className: "text-4xl" }, selected.icon),
                React.createElement("div", null,
                    React.createElement("div", { className: "flex items-center gap-2 flex-wrap" },
                        React.createElement("h2", { className: "text-2xl font-black text-white" }, selected.name),
                        React.createElement(Tag, { c: CAT_COLORS[selected.cat] }, selected.cat)),
                    React.createElement("p", { className: "text-slate-500 text-sm mt-1" }, selected.desc))),
            awards[selected.id] ? (() => {
                var _a;
                const aw = awards[selected.id];
                const qc = aw.quality === "ok" ? "#4ade80" : aw.quality === "warn" ? "#facc15" : "#f87171";
                const col = CAT_COLORS[selected.cat] || "#facc15";
                return (React.createElement("div", { className: "rounded-2xl p-5 mb-5 text-center border", style: { background: "#070d18", borderColor: col + "44" } },
                    React.createElement("div", { className: "text-xs font-black uppercase tracking-widest mb-1", style: { color: col } }, "GEWINNER"),
                    React.createElement("div", { className: "text-2xl font-black text-white" }, aw.winner),
                    aw.value !== undefined && (React.createElement("div", { className: "text-sm font-mono mt-1", style: { color: "#94a3b8" } },
                        typeof aw.value === "number" ? aw.value.toFixed(2) : aw.value,
                        aw.unit ? ` ${aw.unit}` : "")),
                    aw.detail && React.createElement("div", { className: "text-xs text-slate-500 mt-2" }, aw.detail),
                    aw.runnerUp && React.createElement("div", { className: "text-xs text-slate-500 mt-2" },
                        "2. Platz: ",
                        aw.runnerUp),
                    React.createElement("div", { className: "mt-3 flex items-center justify-center gap-1.5" },
                        React.createElement("span", { style: { width: 7, height: 7, borderRadius: "50%", display: "inline-block", background: qc } }),
                        React.createElement("span", { className: "text-xs font-bold", style: { color: qc } }, aw.quality === "ok" ? "Daten vollständig" : aw.quality === "warn" ? "Teilweise Daten" : aw.quality === "low" ? "Datenbasis schwach" : "")),
                    ((_a = aw.issues) === null || _a === void 0 ? void 0 : _a.length) > 0 && (React.createElement("div", { className: "mt-1 text-xs", style: { color: "#64748b" } }, aw.issues.join(" · ")))));
            })() : selected.method === "vote" ? null : (React.createElement("div", { className: "rounded-xl p-4 border border-slate-800 text-sm text-slate-600 mb-5 space-y-2" }, selected.method === "box" ? (React.createElement("div", null,
                React.createElement("div", { className: "font-bold text-slate-500 mb-1" }, (data === null || data === void 0 ? void 0 : data.boxscoresLoaded)
                    ? "⚠ Boxscores geladen, aber kein Ergebnis berechnet."
                    : "Boxscores nicht geladen."),
                React.createElement("div", { className: "text-xs" }, (data === null || data === void 0 ? void 0 : data.boxscoresLoaded)
                    ? `${(data.boxscores || []).length} Roster-Datensätze (${[...new Set((data.boxscores || []).map(b => b.week))].length} Wochen). ${(data.boxscores || []).find(b => { var _a, _b; return (_b = (_a = b.home) === null || _a === void 0 ? void 0 : _a.slots) === null || _b === void 0 ? void 0 : _b.some(s => s.pts > 0); }) ? "Punkte vorhanden ✓" : "Alle pts=0 — Cache löschen (F12→Application→LocalStorage→ff_v2_*→Delete)"}`
                    : "Boxscores werden automatisch beim nächsten Laden mitgeladen (Cache abgelaufen → F5)."))) : selected.method === "check" ? (React.createElement("div", null, "Dieser Award wird manuell vergeben (keine API-Daten verf\u00FCgbar).")) : (React.createElement("div", null,
                React.createElement("div", { className: "font-bold text-slate-500 mb-1" }, "Wird automatisch berechnet."),
                React.createElement("div", { className: "text-xs" }, !((_a = data === null || data === void 0 ? void 0 : data.teams) === null || _a === void 0 ? void 0 : _a.length) ? "Teams fehlen." :
                    !((_b = data === null || data === void 0 ? void 0 : data.weeklyScores) === null || _b === void 0 ? void 0 : _b.length) ? "Scoreboard fehlt." :
                        "Daten geladen — Award sollte sichtbar sein. Seite neu laden?"))))),
            selected.method === "vote" && (React.createElement(VotingPanel, { key: selected.id, award: selected, session: session, liveData: liveData })))))));
}
// ─── STATS PAGE ───────────────────────────────────────────────────────────────
function StatsPage({ data, session, onSeasonChange }) {
    var _a;
    const [sub, setSub] = useState("league");
    const [teamFilter, setTeamFilter] = useState("all");
    const [metric, setMetric] = useState("pts");
    const teams = (data === null || data === void 0 ? void 0 : data.standings) || [];
    const weekly = (data === null || data === void 0 ? void 0 : data.weeklyScores) || [];
    const txItems = (data === null || data === void 0 ? void 0 : data.transactions) || [];
    const byPts = [...teams].sort((a, b) => b.pointsFor - a.pointsFor);
    const standData = byPts.map((t, i) => ({
        name: t.name.split(" ").pop(), full: t.name, pts: +t.pointsFor.toFixed(1),
        pa: +(t.pointsAgainst || 0).toFixed(1), wins: t.wins, losses: t.losses,
        luck: t.luck || 0, fill: TEAM_PALETTE[i % TEAM_PALETTE.length]
    }));
    const teamGames = teamFilter === "all"
        ? weekly
        : weekly.filter(g => g.home === teamFilter || g.away === teamFilter);
    const lineData = teamFilter === "all" ? [] : teamGames.map(g => ({
        week: `W${g.week}`,
        score: +(teamFilter === g.home ? g.homeScore : g.awayScore).toFixed(1),
        opp: +(teamFilter === g.home ? g.awayScore : g.homeScore).toFixed(1),
    }));
    const metricData = standData.map(d => ({ ...d, val: d[metric] || 0 }));
    const METRICS = [
        { k: "pts", label: "Punkte For" },
        { k: "pa", label: "Punkte Against" },
        { k: "wins", label: "Wins" },
        { k: "luck", label: "Luck" },
    ];
    // Transactions per team
    const txByTeam = {};
    teams.forEach(t => { txByTeam[t.name] = { adds: 0, waivers: 0, trades: 0 }; });
    txItems.forEach(tx => {
        if (!txByTeam[tx.teamName])
            return;
        if (tx.type === "ADD")
            txByTeam[tx.teamName].adds++;
        if (tx.type === "WAIVER_CLAIM")
            txByTeam[tx.teamName].waivers++;
        if (tx.type === "TRADE")
            txByTeam[tx.teamName].trades++;
    });
    const txData = Object.entries(txByTeam)
        .map(([name, v], i) => ({ name: name.split(" ").pop(), full: name, ...v, fill: TEAM_PALETTE[i % TEAM_PALETTE.length] }))
        .sort((a, b) => b.adds - a.adds);
    return (React.createElement("div", { className: "overflow-y-auto", style: { height: "calc(100vh - 57px)" } },
        React.createElement("div", { className: "sticky top-0 z-10 px-5 py-3 border-b border-slate-800 flex items-center gap-3 flex-wrap", style: { background: "#070d18" } },
            React.createElement("div", { className: "flex gap-1.5" }, [["league", "🏟️ Liga"], ["team", "👤 Team"], ["moves", "🔄 Moves"], ["trades", "🤝 Trades"], ["history", "📅 Historie"]].map(([id, label]) => (React.createElement("button", { key: id, onClick: () => setSub(id), className: "px-3 py-1.5 rounded-lg font-black text-xs transition-all", style: { background: sub === id ? "#facc15" : "transparent", color: sub === id ? "#000" : "#64748b" } }, label)))),
            React.createElement("div", { className: "flex-1" }),
            React.createElement("select", { className: "rounded-lg px-2 py-1.5 text-xs text-white outline-none font-mono", style: { background: "#0b1929", border: "1px solid #1e3a5f" }, value: session.season, onChange: e => onSeasonChange(+e.target.value) }, [2028, 2027, 2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018].map(y => React.createElement("option", { key: y, value: y }, y))),
            (data === null || data === void 0 ? void 0 : data.loading) && React.createElement(Spinner, { sz: 14 })),
        React.createElement("div", { className: "p-5 space-y-5" },
            sub === "league" && (React.createElement(React.Fragment, null,
                React.createElement("div", { className: "flex gap-2 flex-wrap items-center" },
                    React.createElement("span", { className: "text-xs text-slate-600 font-mono" }, "Ansicht:"),
                    METRICS.map(m => (React.createElement("button", { key: m.k, onClick: () => setMetric(m.k), className: "px-3 py-1 rounded-lg text-xs font-bold transition-all border", style: { background: metric === m.k ? "#facc1522" : "transparent",
                            borderColor: metric === m.k ? "#facc15" : "#1e3a5f",
                            color: metric === m.k ? "#facc15" : "#475569" } }, m.label)))),
                React.createElement("div", { className: "rounded-2xl border border-slate-700 p-5", style: { background: "#080f1a" } },
                    React.createElement("h3", { className: "text-xs font-black uppercase tracking-widest text-slate-400 mb-4" }, (_a = METRICS.find(m => m.k === metric)) === null || _a === void 0 ? void 0 :
                        _a.label,
                        " \u2013 alle Teams"),
                    React.createElement(SvgBarChart, { data: metricData, dataKey: "val", nameKey: "name", height: 220, getCellColor: d => d.fill })),
                React.createElement("div", { className: "rounded-2xl border border-slate-700 overflow-hidden", style: { background: "#080f1a" } },
                    React.createElement("div", { className: "px-5 py-3 border-b border-slate-800 flex items-center justify-between" },
                        React.createElement("h3", { className: "text-xs font-black uppercase tracking-widest text-slate-400" }, "Standings"),
                        React.createElement("span", { className: "text-xs text-slate-600" }, session.season)),
                    React.createElement("div", { className: "overflow-x-auto" },
                        React.createElement("table", { className: "w-full text-xs" },
                            React.createElement("thead", null,
                                React.createElement("tr", { className: "border-b border-slate-800 text-slate-600" }, ["#", "Team", "W", "L", "PF", "PA", "Luck"].map(h => React.createElement("th", { key: h, className: "text-left px-4 py-2.5 font-bold uppercase" }, h)))),
                            React.createElement("tbody", null, [...teams].sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor).map((t, i) => (React.createElement("tr", { key: t.id, className: "border-b border-slate-900 hover:bg-slate-800 transition-colors" },
                                React.createElement("td", { className: "px-4 py-2 text-slate-600 font-mono" }, i + 1),
                                React.createElement("td", { className: "px-4 py-2 font-bold text-white" }, t.name),
                                React.createElement("td", { className: "px-4 py-2 text-green-400 font-mono" }, t.wins),
                                React.createElement("td", { className: "px-4 py-2 text-red-400 font-mono" }, t.losses),
                                React.createElement("td", { className: "px-4 py-2 font-mono", style: { color: "#facc15" } }, (t.pointsFor || 0).toFixed(1)),
                                React.createElement("td", { className: "px-4 py-2 font-mono text-slate-500" }, (t.pointsAgainst || 0).toFixed(1)),
                                React.createElement("td", { className: "px-4 py-2 font-mono font-bold", style: { color: (t.luck || 0) >= 0 ? "#4ade80" : "#f87171" } },
                                    (t.luck || 0) > 0 ? "+" : "",
                                    t.luck || 0)))))))))),
            sub === "team" && (React.createElement(React.Fragment, null,
                React.createElement("div", { className: "flex items-center gap-3 flex-wrap" },
                    React.createElement("select", { className: "rounded-xl px-3 py-2.5 text-sm text-white outline-none", style: { background: "#0b1929", border: "1px solid #1e3a5f", fontFamily: "inherit" }, value: teamFilter, onChange: e => setTeamFilter(e.target.value) },
                        React.createElement("option", { value: "all" }, "Alle Teams"),
                        teams.map(t => React.createElement("option", { key: t.id, value: t.name }, t.name)))),
                teamFilter === "all" ? (React.createElement("div", { className: "rounded-xl p-4 border border-slate-800 text-center text-sm text-slate-500", style: { background: "#080f1a" } }, "Team ausw\u00E4hlen um Wochenverlauf anzuzeigen.")) : (React.createElement(React.Fragment, null,
                    (() => {
                        const t = teams.find(x => x.name === teamFilter);
                        if (!t)
                            return null;
                        return (React.createElement("div", { className: "grid grid-cols-2 md:grid-cols-4 gap-3" }, [{ l: "Wins", v: t.wins, c: "#4ade80" }, { l: "Losses", v: t.losses, c: "#f87171" }, { l: "PF", v: (t.pointsFor || 0).toFixed(1), c: "#facc15" }, { l: "PA", v: (t.pointsAgainst || 0).toFixed(1), c: "#fb923c" }].map(s => (React.createElement("div", { key: s.l, className: "rounded-xl p-4 border text-center", style: { background: "#080f1a", borderColor: s.c + "33" } },
                            React.createElement("div", { className: "text-2xl font-black", style: { color: s.c } }, s.v),
                            React.createElement("div", { className: "text-xs text-slate-500 mt-0.5" }, s.l))))));
                    })(),
                    React.createElement("div", { className: "rounded-2xl border border-slate-700 p-5", style: { background: "#080f1a" } },
                        React.createElement("h3", { className: "text-xs font-black uppercase tracking-widest text-slate-400 mb-4" },
                            "W\u00F6chentliche Scores \u2013 ",
                            teamFilter.split(" ").pop()),
                        React.createElement(SvgLineChart, { data: lineData, nameKey: "week", height: 220, lines: [{ k: "score", color: "#facc15", label: "Eigene Pts", w: 2 }, { k: "opp", color: "#f472b6", label: "Gegner Pts", w: 1.5, dash: "4 2" }] })),
                    React.createElement("div", { className: "rounded-2xl border border-slate-700 p-5", style: { background: "#080f1a" } },
                        React.createElement("h3", { className: "text-xs font-black uppercase tracking-widest text-slate-400 mb-4" }, "W/L Verlauf"),
                        React.createElement("div", { className: "flex gap-1.5 flex-wrap" }, lineData.map((g, i) => {
                            const win = g.score > g.opp;
                            return (React.createElement("div", { key: i, className: "text-center" },
                                React.createElement("div", { className: "w-9 h-9 rounded-lg flex items-center justify-center text-xs font-black mb-1", style: { background: win ? "#14532d" : "#450a0a", color: win ? "#4ade80" : "#f87171" } }, win ? "W" : "L"),
                                React.createElement("span", { className: "text-xs font-mono", style: { color: "#475569" } }, g.week)));
                        }))))))),
            sub === "moves" && (React.createElement(React.Fragment, null,
                React.createElement("div", { className: "flex gap-2 flex-wrap items-center" },
                    React.createElement("span", { className: "text-xs text-slate-600 font-mono" }, "Ansicht:"),
                    [{ k: "adds", label: "Adds" }, { k: "waivers", label: "Waiver" }, { k: "trades", label: "Trades" }].map(m => (React.createElement("button", { key: m.k, onClick: () => setMetric(m.k), className: "px-3 py-1 rounded-lg text-xs font-bold transition-all border", style: { background: metric === m.k ? "#34d39922" : "transparent",
                            borderColor: metric === m.k ? "#34d399" : "#1e3a5f",
                            color: metric === m.k ? "#34d399" : "#475569" } }, m.label)))),
                React.createElement("div", { className: "rounded-2xl border border-slate-700 p-5", style: { background: "#080f1a" } },
                    React.createElement("h3", { className: "text-xs font-black uppercase tracking-widest text-slate-400 mb-4" },
                        metric === "adds" ? "Free Agency Adds" : metric === "waivers" ? "Waiver Claims" : "Trades",
                        " je Team"),
                    React.createElement(SvgBarChart, { data: txData.sort((a, b) => b[metric] - a[metric]), dataKey: metric, nameKey: "name", height: 200, getCellColor: d => d.fill })),
                txItems.length === 0 && (React.createElement("div", { className: "rounded-xl p-4 border border-slate-800 text-center text-xs text-slate-600", style: { background: "#080f1a" } }, "Keine Transaktionsdaten geladen.")))),
            sub === "trades" && (() => {
                const allTrades = (data === null || data === void 0 ? void 0 : data.trades) || [];
                const [tSort, setTSort] = React.useState("date");
                const [tTeam, setTTeam] = React.useState("all");
                const [tSearch, setTSearch] = React.useState("");
                // Build unique trade pairs (one row per trade, not per team)
                const tradePairs = [];
                const seen = new Set();
                allTrades.forEach(t => {
                    if (seen.has(t.tradeId))
                        return;
                    seen.add(t.tradeId);
                    // Find both sides
                    const side1 = allTrades.find(x => x.tradeId === t.tradeId);
                    const side2 = allTrades.find(x => x.tradeId === t.tradeId && x.teamName !== side1.teamName);
                    if (!side1)
                        return;
                    const totalPts = [...(side1.received || []), ...(side1.sent || [])].reduce((s, p) => s + (p.pts || 0), 0);
                    tradePairs.push({ id: t.tradeId, epochMs: t.epochMs, team1: side1.teamName, team2: (side2 === null || side2 === void 0 ? void 0 : side2.teamName) || "?",
                        sent1: side1.sent || [], recv1: side1.received || [], picks1s: side1.picksSent || [], picks1r: side1.picksReceived || [],
                        totalPts });
                });
                const teams_list = [...new Set(tradePairs.flatMap(t => [t.team1, t.team2]))].filter(Boolean).sort();
                const filtered = tradePairs
                    .filter(t => tTeam === "all" || t.team1 === tTeam || t.team2 === tTeam)
                    .filter(t => !tSearch || JSON.stringify(t).toLowerCase().includes(tSearch.toLowerCase()))
                    .sort((a, b) => {
                    if (tSort === "date")
                        return b.epochMs - a.epochMs;
                    if (tSort === "pts")
                        return b.totalPts - a.totalPts;
                    return 0;
                });
                return (React.createElement("div", { className: "space-y-4" },
                    React.createElement("div", { className: "flex flex-wrap gap-2 items-center" },
                        React.createElement("input", { className: "rounded-xl px-3 py-2 text-xs text-white outline-none flex-1 min-w-32", style: { background: "#0b1929", border: "1px solid #1e3a5f", fontFamily: "inherit" }, placeholder: "Suche Spieler / Team\u2026", value: tSearch, onChange: e => setTSearch(e.target.value) }),
                        React.createElement("select", { className: "rounded-xl px-3 py-2 text-xs text-white outline-none", style: { background: "#0b1929", border: "1px solid #1e3a5f" }, value: tTeam, onChange: e => setTTeam(e.target.value) },
                            React.createElement("option", { value: "all" }, "Alle Teams"),
                            teams_list.map(t => React.createElement("option", { key: t, value: t }, t))),
                        React.createElement("div", { className: "flex gap-1" }, [["date", "📅 Datum"], ["pts", "⭐ Wert"]].map(([k, l]) => (React.createElement("button", { key: k, onClick: () => setTSort(k), className: "px-3 py-2 rounded-xl text-xs font-bold transition-all", style: { background: tSort === k ? "#facc15" : "#0b1929", color: tSort === k ? "#000" : "#64748b", border: "1px solid" + (tSort === k ? "#facc15" : "#1e3a5f") } }, l)))),
                        React.createElement("span", { className: "text-xs text-slate-600" },
                            filtered.length,
                            " Trades")),
                    filtered.length === 0 && (React.createElement("div", { className: "text-center text-xs text-slate-600 py-8" }, allTrades.length === 0 ? "Keine Trade-Daten geladen." : "Keine Treffer.")),
                    filtered.map((t, i) => {
                        const date = t.epochMs ? new Date(+t.epochMs).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "?";
                        return (React.createElement("div", { key: t.id || i, className: "rounded-2xl border border-slate-700 overflow-hidden", style: { background: "#080f1a" } },
                            React.createElement("div", { className: "flex items-center justify-between px-4 py-2.5 border-b border-slate-800", style: { background: "#0a1628" } },
                                React.createElement("span", { className: "text-xs font-bold text-white" },
                                    t.team1.split(" ").pop(),
                                    " \u2194 ",
                                    t.team2.split(" ").pop()),
                                React.createElement("span", { className: "text-xs font-mono text-slate-500" }, date)),
                            React.createElement("div", { className: "grid grid-cols-2 divide-x divide-slate-800" }, [
                                { team: t.team1, received: t.recv1, sent: t.sent1, picksR: t.picks1r, picksS: t.picks1s },
                                { team: t.team2, received: t.sent1, sent: t.recv1, picksR: t.picks1s, picksS: t.picks1r },
                            ].map((side, si) => (React.createElement("div", { key: si, className: "p-3 text-xs space-y-1.5" },
                                React.createElement("div", { className: "font-black text-white text-xs mb-2" }, side.team.split(" ").pop()),
                                side.received.length > 0 && (React.createElement("div", null,
                                    React.createElement("span", { className: "text-green-400 font-bold" }, "+ "),
                                    side.received.map((p, pi) => (React.createElement("span", { key: pi, className: "mr-1" },
                                        React.createElement("span", { className: "text-white" }, p.name),
                                        p.pos && React.createElement("span", { className: "text-slate-600" },
                                            " (",
                                            p.pos,
                                            ")"),
                                        p.pts > 0 && React.createElement("span", { style: { color: "#facc15" } },
                                            " ",
                                            p.pts.toFixed(0))))),
                                    side.picksR.map((p, pi) => React.createElement("span", { key: "pr" + pi, className: "mr-1 text-blue-400" }, p)))),
                                side.sent.length > 0 && (React.createElement("div", null,
                                    React.createElement("span", { className: "text-red-400 font-bold" }, "- "),
                                    side.sent.map((p, pi) => (React.createElement("span", { key: pi, className: "mr-1 text-slate-400" },
                                        p.name,
                                        p.pts > 0 && React.createElement("span", { style: { color: "#94a3b8" } },
                                            " ",
                                            p.pts.toFixed(0))))),
                                    side.picksS.map((p, pi) => React.createElement("span", { key: "ps" + pi, className: "mr-1 text-blue-300" }, p))))))))));
                    })));
            })(),
            sub === "history" && (React.createElement(React.Fragment, null,
                (data === null || data === void 0 ? void 0 : data.awards) && (() => {
                    const counts = {};
                    Object.values(data.awards).forEach(a => { if (a.winner)
                        counts[a.winner] = (counts[a.winner] || 0) + 1; });
                    const d = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, count], i) => ({ name: name.split(" ").pop(), count, fill: TEAM_PALETTE[i % TEAM_PALETTE.length] }));
                    return d.length > 0 ? (React.createElement("div", { className: "rounded-2xl border border-slate-700 p-5", style: { background: "#080f1a" } },
                        React.createElement("h3", { className: "text-xs font-black uppercase tracking-widest text-slate-400 mb-4" },
                            "Awards je Team \u2013 Saison ",
                            session.season),
                        React.createElement(SvgBarChart, { data: d, dataKey: "count", nameKey: "name", height: 200, getCellColor: d => d.fill }))) : null;
                })(),
                React.createElement("div", { className: "text-center text-xs py-1", style: { color: (data === null || data === void 0 ? void 0 : data.boxscoresLoaded) ? "#4ade80" : "#64748b" } }, (data === null || data === void 0 ? void 0 : data.boxscoresLoaded)
                    ? `✓ Boxscores geladen — Awards #1–#30 verfügbar (${(data.boxscores || []).length} Spiele)`
                    : "Boxscores werden beim nächsten Laden mitgeladen (Cache abgelaufen)"),
                React.createElement("div", { className: "rounded-xl p-4 border border-slate-800 text-xs text-slate-500 text-center", style: { background: "#080f1a" } }, "Andere Saison: Dropdown oben rechts \u00E4ndern \u2192 Daten werden neu geladen."))))));
}
// ─── LOADING SCREEN ───────────────────────────────────────────────────────────
function LoadingScreen({ session, progress, error, debugLog, onCancel }) {
    const STEPS = [
        { label: "Cache prüfen", detail: "" },
        { label: "Standings laden", detail: `Liga ${session.leagueId} · Saison ${session.season}` },
        { label: "Scoreboard laden", detail: "Woche 1–17 inkl. Projektion…" },
        { label: "Transaktionen laden", detail: "Adds, Drops, Trades, Waiver…" },
        { label: "Boxscores laden", detail: "Spieler-Stats, Bench, Coach %…" },
        { label: "Awards berechnen", detail: "Automatische Auswertung…" },
        { label: "Daten prüfen", detail: "Validierung + Vollständigkeit…" },
    ];
    return (React.createElement("div", { className: "min-h-screen flex items-center justify-center p-6", style: { background: "radial-gradient(ellipse at 30% 20%, #0d2040 0%, #040a12 70%)" } },
        React.createElement("div", { className: "w-full max-w-sm" },
            React.createElement("div", { className: "text-center mb-8" },
                React.createElement("div", { className: "text-4xl mb-2" }, "\uD83C\uDFC8"),
                React.createElement("h2", { className: "text-2xl font-black text-white tracking-tighter" },
                    "Lade Liga ",
                    session.leagueId),
                React.createElement("p", { className: "text-xs text-slate-600 mt-1" },
                    "Saison ",
                    session.season)),
            React.createElement("div", { className: "rounded-2xl border border-slate-700 p-6", style: { background: "#080f1a" } },
                React.createElement(ProgressBar, { steps: STEPS, current: progress }),
                error && (React.createElement("div", { className: "mt-4 rounded-xl px-4 py-3 text-xs", style: { background: "#450a0a", color: "#fca5a5", border: "1px solid #7f1d1d" } },
                    "\u26A0 ",
                    error)),
                React.createElement("button", { onClick: onCancel, className: "mt-5 w-full text-center text-xs", style: { color: "#374151" } }, "\u2190 Zur\u00FCck zur Liga-Auswahl"),
                (debugLog === null || debugLog === void 0 ? void 0 : debugLog.length) > 0 && (React.createElement("div", { className: "mt-4 rounded-xl p-3 text-xs font-mono overflow-y-auto max-h-48", style: { background: "#040810", color: "#4ade80", border: "1px solid #166534" } }, debugLog.map((l, i) => React.createElement("div", { key: i }, l))))))));
}
// ─── QUICK SWITCHER MODAL ─────────────────────────────────────────────────────
function QuickSwitcher({ session, onSwitch, onClose, onLogout }) {
    const [season, setSeason] = useState(String(session.season));
    const [leagueId, setLeague] = useState(String(session.leagueId));
    const [manualId, setManualId] = useState("");
    // Load cached leagues
    const cachedLeagues = (() => {
        try {
            return JSON.parse(localStorage.getItem("ff_leagues") || "[]");
        }
        catch {
            return [];
        }
    })();
    const [leagues, setLeagues] = useState(cachedLeagues);
    const [fetching, setFetching] = useState(false);
    // Try to refresh leagues from stored userId
    useEffect(() => {
        const uid = localStorage.getItem("ff_uid");
        if (!uid || leagues.length)
            return;
        setFetching(true);
        fetchLeaguesByUserId(uid)
            .then(found => { if (found.length) {
            setLeagues(found);
            localStorage.setItem("ff_leagues", JSON.stringify(found));
        } })
            .catch(() => { })
            .finally(() => setFetching(false));
    }, []);
    const select = (l) => { setLeague(l.id); setSeason(String(l.season)); };
    return (React.createElement("div", { className: "fixed inset-0 z-50 flex items-center justify-center p-4", style: { background: "rgba(0,0,0,0.75)", backdropFilter: "blur(4px)" }, onClick: onClose },
        React.createElement("div", { className: "w-full max-w-sm rounded-2xl border border-slate-700 overflow-hidden", style: { background: "#080f1a" }, onClick: e => e.stopPropagation() },
            React.createElement("div", { className: "flex items-center justify-between px-5 py-4 border-b border-slate-800" },
                React.createElement("span", { className: "text-sm font-black text-white" }, "\u2699 Liga / Saison wechseln"),
                React.createElement("button", { onClick: onClose, className: "text-slate-600 hover:text-white text-lg leading-none" }, "\u2715")),
            React.createElement("div", { className: "p-5 space-y-4 max-h-screen overflow-y-auto" },
                (leagues.length > 0 || fetching) && (React.createElement("div", null,
                    React.createElement("label", { className: "block text-xs font-bold uppercase tracking-widest mb-2", style: { color: "#475569" } },
                        "Deine Ligen ",
                        fetching && React.createElement(Spinner, { sz: 10 })),
                    React.createElement("div", { className: "space-y-1.5 max-h-36 overflow-y-auto pr-1" }, leagues.map(l => (React.createElement("button", { key: l.id, onClick: () => select(l), className: "w-full text-left px-3 py-2 rounded-xl border text-sm font-medium transition-all", style: { background: leagueId === l.id ? "#facc1512" : "#0b1525",
                            borderColor: leagueId === l.id ? "#facc15" : "#1e3a5f",
                            color: leagueId === l.id ? "#facc15" : "#cbd5e1" } },
                        React.createElement("span", { className: "font-bold" },
                            leagueId === l.id && "✓ ",
                            l.name),
                        React.createElement("span", { className: "text-xs ml-2", style: { color: "#475569" } },
                            "ID ",
                            l.id,
                            " \u00B7 ",
                            l.season))))))),
                React.createElement("div", null,
                    React.createElement("label", { className: "block text-xs font-bold uppercase tracking-widest mb-1.5", style: { color: "#475569" } }, "Andere Liga-ID"),
                    React.createElement("div", { className: "flex gap-2" },
                        React.createElement("input", { className: "flex-1 rounded-xl px-3 py-2 text-sm text-white outline-none", style: { background: "#0b1929", border: "1px solid #1e3a5f", fontFamily: "inherit" }, placeholder: "z.B. 297091", value: manualId, onChange: e => setManualId(e.target.value), onKeyDown: e => e.key === "Enter" && manualId.trim() && (setLeague(manualId.trim()), setManualId("")) }),
                        React.createElement("button", { onClick: () => { if (manualId.trim()) {
                                setLeague(manualId.trim());
                                setManualId("");
                            } }, className: "px-3 py-2 rounded-xl text-xs font-bold", style: { background: "#facc15", color: "#000" } }, "OK"))),
                React.createElement("div", null,
                    React.createElement("label", { className: "block text-xs font-bold uppercase tracking-widest mb-1.5", style: { color: "#475569" } }, "Saison"),
                    React.createElement("select", { className: "w-full rounded-xl px-3 py-2.5 text-sm text-white outline-none", style: { background: "#0b1929", border: "1px solid #1e3a5f", fontFamily: "inherit" }, value: season, onChange: e => setSeason(e.target.value) }, [2028, 2027, 2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018].map(y => React.createElement("option", { key: y, value: y }, y)))),
                leagueId && (React.createElement("div", { className: "rounded-xl px-3 py-2 text-xs font-mono", style: { background: "#0b1929", color: "#64748b" } },
                    "Aktive Wahl: Liga ",
                    leagueId,
                    " \u00B7 Saison ",
                    season)),
                React.createElement("div", { className: "flex gap-2" },
                    React.createElement("button", { onClick: () => onSwitch({ leagueId, season: +season }), disabled: !leagueId, className: "flex-1 py-3 rounded-xl font-black text-sm transition-all hover:brightness-110 disabled:opacity-30", style: { background: "linear-gradient(135deg,#facc15,#f59e0b)", color: "#000" } }, "Laden \u2192"),
                    React.createElement("button", { onClick: onLogout, className: "px-4 py-3 rounded-xl text-xs font-bold", style: { background: "#1c0505", color: "#f87171", border: "1px solid #7f1d1d" } }, "Logout"))))));
}
// ─── MAIN APP ─────────────────────────────────────────────────────────────────

// Android intent handler: called when app is opened from a Fleaflicker league URL
window.onAndroidIntent = function(leagueId) {
  // Store for use at login
  if (leagueId) {
    localStorage.setItem('ff_intent_league', leagueId);
    // If app is already loaded, notify
    if (window.__mounted) {
      const ev = new CustomEvent('ff-intent-league', { detail: leagueId });
      window.dispatchEvent(ev);
    }
  }
};

function App() {
    var _a;
    const [session, setSession] = useState(null);
    const [phase, setPhase] = useState("login");
    const [debugLog, setDebugLog] = useState([]);
    const dbg = (msg) => setDebugLog(d => [...d.slice(-40), String(msg)]); // login | loading | app
    const [tab, setTab] = useState("awards");
    const [loadProgress, setLoadProgress] = useState(0);
    const [loadError, setLoadError] = useState("");
    const [data, setData] = useState(null);
    const [showSwitcher, setShowSwitcher] = useState(false);
    // ── Full data load with caching ─────────────────────────────────────────
    // ── Data validation + retry helper ──────────────────────────────────────
    const validateData = (d) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
        const issues = [];
        if (!((_a = d.teams) === null || _a === void 0 ? void 0 : _a.length))
            issues.push({ field: "teams", msg: "Keine Teams geladen" });
        if ((_b = d.teams) === null || _b === void 0 ? void 0 : _b.some(t => !t.pointsFor))
            issues.push({ field: "pointsFor", msg: "Punkte fehlen bei manchen Teams (0 oder null)" });
        if (!((_c = d.weeklyScores) === null || _c === void 0 ? void 0 : _c.length))
            issues.push({ field: "scoreboard", msg: "Kein Scoreboard geladen" });
        else if (d.weeklyScores.length < 3)
            issues.push({ field: "scoreboard", msg: `Nur ${d.weeklyScores.length} Woche(n) geladen` });
        const projMissing = ((_d = d.weeklyScores) === null || _d === void 0 ? void 0 : _d.filter(g => !g.homeProj && !g.awayProj).length) || 0;
        if (projMissing === ((_e = d.weeklyScores) === null || _e === void 0 ? void 0 : _e.length) && ((_f = d.weeklyScores) === null || _f === void 0 ? void 0 : _f.length) > 0)
            issues.push({ field: "projected", msg: "Keine Projektionsdaten — Luck basiert auf API-Wert" });
        if (!((_g = d.transactions) === null || _g === void 0 ? void 0 : _g.length))
            issues.push({ field: "transactions", msg: "Keine Transaktionen (Moves-Awards nicht berechenbar)" });
        const teamsNoLuck = ((_h = d.teams) === null || _h === void 0 ? void 0 : _h.filter(t => (t.luck || 0) === 0).length) || 0;
        if (teamsNoLuck === ((_j = d.teams) === null || _j === void 0 ? void 0 : _j.length) && ((_k = d.teams) === null || _k === void 0 ? void 0 : _k.length) > 0)
            issues.push({ field: "luck", msg: "Alle Luck-Werte = 0 (Projektion fehlt + API gibt 0)" });
        if (!((_l = d.trades) === null || _l === void 0 ? void 0 : _l.length))
            issues.push({ field: "trades", msg: "Keine Trade-Daten (FetchTrades ggf. nicht verfügbar)" });
        if (!((_m = d.boxscores) === null || _m === void 0 ? void 0 : _m.length))
            issues.push({ field: "boxscores", msg: "Keine Boxscore-Daten (Awards #1,#2,#20–#30 fehlen)" });
        return issues;
    };
    const retryFetch = async (fn, label, retries = 2) => {
        for (let i = 0; i <= retries; i++) {
            try {
                const result = await fn();
                if (result !== null && result !== undefined)
                    return result;
            }
            catch (e) {
                if (i === retries)
                    throw e;
                await new Promise(r => setTimeout(r, 1200 * (i + 1)));
            }
        }
        return null;
    };
    const loadLeague = useCallback(async (sess) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11, _12, _13, _14, _15, _16;
        setPhase("loading");
        setLoadProgress(0);
        setLoadError("");
        // Step 0: Check cache
        setLoadProgress(0);
        const cached = await loadFromCache(sess.leagueId, sess.season);
        if (cached) {
            // Validate cache quality — if missing critical data, reload
            const cacheOk = ((_a = cached.teams) === null || _a === void 0 ? void 0 : _a.length) > 0
                && ((_b = cached.weeklyScores) === null || _b === void 0 ? void 0 : _b.length) >= 3
                && ((_c = cached.boxscores) === null || _c === void 0 ? void 0 : _c.length) > 0; // require boxscores
            if (cacheOk) {
                const awards = computeAutoAwards(cached);
                setData({ ...cached, awards, loading: false });
                setPhase("app");
                return;
            }
            // Cache exists but is incomplete — fall through to full reload
        }
        try {
            // Step 1: Standings (with retry)
            setLoadProgress(1);
            const raw = await retryFetch(() => fetchFF("FetchLeagueStandings", { league_id: sess.leagueId, season: sess.season }), "Standings");
            if (!raw)
                throw new Error("Standings konnten nicht geladen werden (3 Versuche).");
            const rawTeams = (raw.divisions || []).flatMap(d => d.teams || []);
            const teams = rawTeams.map(t => {
                var _a, _b, _c, _d;
                return ({
                    id: t.id, name: t.name,
                    wins: ((_a = t.recordOverall) === null || _a === void 0 ? void 0 : _a.wins) || 0, losses: ((_b = t.recordOverall) === null || _b === void 0 ? void 0 : _b.losses) || 0,
                    pointsFor: ((_c = t.pointsFor) === null || _c === void 0 ? void 0 : _c.value) || 0, pointsAgainst: ((_d = t.pointsAgainst) === null || _d === void 0 ? void 0 : _d.value) || 0,
                    luck: t.luck || 0, // replaced below once weeklyScores are loaded
                });
            });
            // Helper: compute custom luck AFTER weeklyScores exist
            const applyCustomLuck = (teamList, scores) => {
                // For each team, each week: luckPct = (actual - projected) / projected * 100
                // Luck score = average luckPct across all weeks with valid projection
                const weekData = {};
                scores.forEach(g => {
                    if (!weekData[g.home])
                        weekData[g.home] = [];
                    if (!weekData[g.away])
                        weekData[g.away] = [];
                    if (g.homeScore > 0)
                        weekData[g.home].push({ actual: g.homeScore, proj: g.homeProj || 0 });
                    if (g.awayScore > 0)
                        weekData[g.away].push({ actual: g.awayScore, proj: g.awayProj || 0 });
                });
                return teamList.map(t => {
                    const weeks = (weekData[t.name] || []).filter(w => w.proj > 0);
                    if (!weeks.length)
                        return t; // keep API luck if no projections
                    const avgLuckPct = weeks.reduce((s, w) => s + (w.actual - w.proj) / w.proj * 100, 0) / weeks.length;
                    return { ...t, luck: +avgLuckPct.toFixed(1), luckSource: "projected" };
                });
            };
            // Save team names for voting (no team selection at login)
            localStorage.setItem(`ff_teams_${sess.leagueId}`, JSON.stringify(teams.map(t => t.name)));
            // Step 2: Scoreboard (weeks 1–17)
            setLoadProgress(2);
            const weeklyScores = [];
            for (let wk = 1; wk <= 17; wk++) {
                try {
                    const sb = await fetchFF("FetchLeagueScoreboard", { league_id: sess.leagueId, season: sess.season, scoring_period: wk });
                    for (const g of (sb.games || [])) {
                        // actual scores — try multiple field paths (API varies by season/client)
                        const h = (_j = (_f = (_e = (_d = g.home) === null || _d === void 0 ? void 0 : _d.score) === null || _e === void 0 ? void 0 : _e.value) !== null && _f !== void 0 ? _f : (_h = (_g = g.home_score) === null || _g === void 0 ? void 0 : _g.score) === null || _h === void 0 ? void 0 : _h.value) !== null && _j !== void 0 ? _j : 0;
                        const a = (_q = (_m = (_l = (_k = g.away) === null || _k === void 0 ? void 0 : _k.score) === null || _l === void 0 ? void 0 : _l.value) !== null && _m !== void 0 ? _m : (_p = (_o = g.away_score) === null || _o === void 0 ? void 0 : _o.score) === null || _p === void 0 ? void 0 : _p.value) !== null && _q !== void 0 ? _q : 0;
                        // projected scores for custom luck calculation
                        const hp = (_0 = (_w = (_t = (_s = (_r = g.home) === null || _r === void 0 ? void 0 : _r.projected_score) === null || _s === void 0 ? void 0 : _s.value) !== null && _t !== void 0 ? _t : (_v = (_u = g.home_score) === null || _u === void 0 ? void 0 : _u.projected) === null || _v === void 0 ? void 0 : _v.value) !== null && _w !== void 0 ? _w : (_z = (_y = (_x = g.home) === null || _x === void 0 ? void 0 : _x.score) === null || _y === void 0 ? void 0 : _y.projected) === null || _z === void 0 ? void 0 : _z.value) !== null && _0 !== void 0 ? _0 : 0;
                        const ap = (_10 = (_6 = (_3 = (_2 = (_1 = g.away) === null || _1 === void 0 ? void 0 : _1.projected_score) === null || _2 === void 0 ? void 0 : _2.value) !== null && _3 !== void 0 ? _3 : (_5 = (_4 = g.away_score) === null || _4 === void 0 ? void 0 : _4.projected) === null || _5 === void 0 ? void 0 : _5.value) !== null && _6 !== void 0 ? _6 : (_9 = (_8 = (_7 = g.away) === null || _7 === void 0 ? void 0 : _7.score) === null || _8 === void 0 ? void 0 : _8.projected) === null || _9 === void 0 ? void 0 : _9.value) !== null && _10 !== void 0 ? _10 : 0;
                        const hn = ((_12 = (_11 = g.home) === null || _11 === void 0 ? void 0 : _11.team) === null || _12 === void 0 ? void 0 : _12.name) || ((_13 = g.home) === null || _13 === void 0 ? void 0 : _13.name) || "?";
                        const an = ((_15 = (_14 = g.away) === null || _14 === void 0 ? void 0 : _14.team) === null || _15 === void 0 ? void 0 : _15.name) || ((_16 = g.away) === null || _16 === void 0 ? void 0 : _16.name) || "?";
                        if (!h && !a)
                            continue;
                        weeklyScores.push({
                            week: wk, home: hn, away: an,
                            homeScore: h, awayScore: a,
                            homeProj: hp, awayProj: ap,
                            // gameId: try multiple fields — Fleaflicker uses int64 string
                            gameId: g.id || g.game_id || String(g.fantasy_game_id || ""),
                        });
                    }
                }
                catch {
                    break;
                }
            }
            // Step 3b: Load completed trades with full player details
            const trades = [];
            try {
                let tradeOff = 0;
                while (true) {
                    const tRes = await retryFetch(() => fetchFF("FetchTrades", {
                        league_id: sess.leagueId, season: sess.season,
                        filter: "TRADES_COMPLETED", result_offset: tradeOff
                    }), "Trades");
                    const tList = (tRes === null || tRes === void 0 ? void 0 : tRes.trades) || [];
                    if (!tList.length)
                        break;
                    tList.forEach(trade => {
                        // Each trade has 2 teams
                        const teams_in_trade = trade.teams || [];
                        const tradeId = trade.id;
                        const epochMs = trade.tentative_execution_time || 0;
                        teams_in_trade.forEach(side => {
                            var _a, _b, _c;
                            const teamName = ((_a = side.team) === null || _a === void 0 ? void 0 : _a.name) || "";
                            // Players going TO this team
                            const received = (side.league_players_receiving || [])
                                .map(p => {
                                var _a, _b, _c, _d;
                                return ({
                                    name: ((_a = p.pro_player) === null || _a === void 0 ? void 0 : _a.name_short) || ((_b = p.pro_player) === null || _b === void 0 ? void 0 : _b.name_full) || "?",
                                    pos: ((_c = p.pro_player) === null || _c === void 0 ? void 0 : _c.position) || "",
                                    pts: ((_d = p.season_points) === null || _d === void 0 ? void 0 : _d.value) || 0,
                                });
                            });
                            // Players going AWAY from this team
                            const sent = (side.league_players_giving || [])
                                .map(p => {
                                var _a, _b, _c, _d;
                                return ({
                                    name: ((_a = p.pro_player) === null || _a === void 0 ? void 0 : _a.name_short) || ((_b = p.pro_player) === null || _b === void 0 ? void 0 : _b.name_full) || "?",
                                    pos: ((_c = p.pro_player) === null || _c === void 0 ? void 0 : _c.position) || "",
                                    pts: ((_d = p.season_points) === null || _d === void 0 ? void 0 : _d.value) || 0,
                                });
                            });
                            // Draft picks going to/from
                            const picksReceived = (side.future_draft_picks_receiving || [])
                                .map(p => { var _a; return `${p.season || "?"}R${((_a = p.slot) === null || _a === void 0 ? void 0 : _a.round) || "?"}`; });
                            const picksSent = (side.future_draft_picks_giving || [])
                                .map(p => { var _a; return `${p.season || "?"}R${((_a = p.slot) === null || _a === void 0 ? void 0 : _a.round) || "?"}`; });
                            if (teamName)
                                trades.push({
                                    tradeId, teamName, epochMs,
                                    received, sent, picksReceived, picksSent,
                                    partner: ((_c = (_b = teams_in_trade.find(s => { var _a; return ((_a = s.team) === null || _a === void 0 ? void 0 : _a.name) !== teamName; })) === null || _b === void 0 ? void 0 : _b.team) === null || _c === void 0 ? void 0 : _c.name) || "",
                                });
                        });
                    });
                    tradeOff += tList.length;
                    if (tList.length < 25)
                        break;
                }
            }
            catch { }
            // Apply custom luck now that weeklyScores are available
            const teamsWithLuck = applyCustomLuck(teams, weeklyScores);
            teamsWithLuck.forEach((t, i) => { teams[i] = t; });
            // Step 3: Transactions (with retry per page)
            setLoadProgress(3);
            const transactions = [];
            try {
                let off = 0;
                while (true) {
                    const txs = await retryFetch(() => fetchFF("FetchLeagueTransactions", { league_id: sess.leagueId, season: sess.season, result_offset: off }), `Transactions offset ${off}`);
                    if (!txs)
                        break;
                    const items = txs.items || txs.transactions || txs.results || [];
                    if (!items.length)
                        break;
                    items.forEach(item => {
                        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
                        const tx = item.transaction || item;
                        const type = tx.type || tx.transaction_type || "";
                        const teamName = ((_a = tx.team) === null || _a === void 0 ? void 0 : _a.name) || tx.team_name || "";
                        const bidAmount = ((_b = tx.bid_amount) === null || _b === void 0 ? void 0 : _b.value) || tx.bid || 0;
                        const epochMs = item.time_epoch_milli || tx.time_epoch_milli || 0;
                        // Player involved (add/drop/waiver)
                        const playerAdded = ((_d = (_c = tx.add_player) === null || _c === void 0 ? void 0 : _c.pro_player) === null || _d === void 0 ? void 0 : _d.name_short)
                            || ((_f = (_e = tx.add_player) === null || _e === void 0 ? void 0 : _e.pro_player) === null || _f === void 0 ? void 0 : _f.name_full) || "";
                        const playerDropped = ((_h = (_g = tx.drop_player) === null || _g === void 0 ? void 0 : _g.pro_player) === null || _h === void 0 ? void 0 : _h.name_short)
                            || ((_k = (_j = tx.drop_player) === null || _j === void 0 ? void 0 : _j.pro_player) === null || _k === void 0 ? void 0 : _k.name_full) || "";
                        const playerPos = ((_m = (_l = tx.add_player) === null || _l === void 0 ? void 0 : _l.pro_player) === null || _m === void 0 ? void 0 : _m.position) || "";
                        // Trade: collect both sides
                        if (type === "TRADE") {
                            // Each trade item may have multiple teams — group by trade_id
                            const tradeId = tx.trade_id || tx.id || epochMs;
                            const tradeTeam = teamName;
                            const tradeAssets = (tx.league_players_going_to || [])
                                .map(p => { var _a, _b; return ((_a = p.pro_player) === null || _a === void 0 ? void 0 : _a.name_short) || ((_b = p.pro_player) === null || _b === void 0 ? void 0 : _b.name_full) || "?"; });
                            if (teamName)
                                transactions.push({
                                    type, teamName, bidAmount: 0, epochMs, tradeId,
                                    tradeAssets, tradePartner: ""
                                });
                        }
                        else {
                            if (teamName)
                                transactions.push({
                                    type, teamName, bidAmount, epochMs,
                                    playerAdded, playerDropped, playerPos
                                });
                        }
                    });
                    off += items.length;
                    if (items.length < 50)
                        break;
                }
            }
            catch { }
            // Step 4: Load boxscores for all games
            setLoadProgress(4);
            const boxscores = [];
            const weeksPlayed = [...new Set(weeklyScores.map(w => w.week))].sort((a, b) => a - b);
            const teamIds = teams.map(t => ({ id: t.id, name: t.name }));
            dbg(`Step 4: ${weeksPlayed.length} weeks, ${teamIds.length} teams = ~${weeksPlayed.length * teamIds.length} calls`);
            // Probe first team/week to discover real field structure
            let probeResult = null;
            if (teamIds.length && weeksPlayed.length) {
                try {
                    probeResult = await fetchFF("FetchRoster", {
                        league_id: sess.leagueId, team_id: teamIds[0].id,
                        season: sess.season, scoring_period: weeksPlayed[0],
                    });
                    if (probeResult) {
                        const topKeys = Object.keys(probeResult);
                        dbg(`FetchRoster top keys: [${topKeys.join(", ")}]`);
                        const groups = probeResult.groups || [];
                        dbg(`groups.length: ${groups.length}`);
                        if (groups[0]) {
                            dbg(`groups[0] keys: [${Object.keys(groups[0]).join(", ")}]`);
                            const slots = groups[0].slots || [];
                            dbg(`groups[0].slots.length: ${slots.length}`);
                            if (slots[0]) {
                                dbg(`slot[0] keys: [${Object.keys(slots[0]).join(", ")}]`);
                                const lp = slots[0].league_player;
                                if (lp) {
                                    dbg(`league_player keys: [${Object.keys(lp).join(", ")}]`);
                                    dbg(`lp.points: ${JSON.stringify(lp.points)}`);
                                    dbg(`lp.game_points: ${JSON.stringify(lp.game_points)}`);
                                    dbg(`lp.season_points: ${JSON.stringify(lp.season_points)}`);
                                    dbg(`lp.points_current_season: ${JSON.stringify(lp.points_current_season)}`);
                                    // log ALL number-like fields
                                    for (const k of Object.keys(lp)) {
                                        const v = lp[k];
                                        if (v && typeof v === "object" && "value" in v) {
                                            dbg(`  lp.${k}.value = ${v.value}`);
                                        }
                                    }
                                }
                                const pos = slots[0].position;
                                if (pos)
                                    dbg(`position: group=${pos.group} label=${pos.label} start=${pos.start}`);
                            }
                        }
                        // Also check if response has slots directly (not via groups)
                        if (probeResult.slots) {
                            dbg(`DIRECT slots found: ${probeResult.slots.length}`);
                        }
                        if (probeResult.roster) {
                            dbg(`probeResult.roster keys: ${Object.keys(probeResult.roster)}`);
                        }
                    }
                    else {
                        dbg("FetchRoster probe returned null");
                    }
                }
                catch (e) {
                    dbg("Probe error: " + e.message);
                }
            }
            // Helper: extract pts from league_player using all known field paths
            const extractPts = (lp) => {
                var _a, _b, _c, _d, _e, _f;
                if (!lp)
                    return 0;
                // Try all known field paths for weekly points
                const candidates = [
                    (_a = lp.points) === null || _a === void 0 ? void 0 : _a.value,
                    (_b = lp.game_points) === null || _b === void 0 ? void 0 : _b.value,
                    (_c = lp.week_points) === null || _c === void 0 ? void 0 : _c.value,
                    (_d = lp.scoring_period_points) === null || _d === void 0 ? void 0 : _d.value,
                    (_e = lp.points_current_period) === null || _e === void 0 ? void 0 : _e.value,
                    (_f = lp.fantasy_points) === null || _f === void 0 ? void 0 : _f.value,
                    lp.pts,
                ];
                for (const c of candidates) {
                    if (typeof c === "number" && c !== 0)
                        return c;
                }
                // If all zero, return 0 (might be a bye week)
                for (const c of candidates) {
                    if (typeof c === "number")
                        return c;
                }
                return 0;
            };
            for (const wk of weeksPlayed) {
                const weekGames = weeklyScores.filter(g => g.week === wk);
                let wkCount = 0;
                for (const team of teamIds) {
                    try {
                        const rData = await fetchFF("FetchRoster", {
                            league_id: sess.leagueId, team_id: team.id,
                            season: sess.season, scoring_period: wk,
                        });
                        if (!rData)
                            continue;
                        // Parse slots: try groups[].slots first, then direct slots
                        const allSlots = (rData.groups || []).flatMap(g => g.slots || []);
                        if (!allSlots.length)
                            continue;
                        const game = weekGames.find(g => g.home === team.name || g.away === team.name);
                        const myScore = game ? (game.home === team.name ? game.homeScore : game.awayScore) : 0;
                        const oppScore = game ? (game.home === team.name ? game.awayScore : game.homeScore) : 0;
                        const won = myScore > oppScore;
                        const slots = allSlots.map(sl => {
                            var _a, _b, _c, _d, _e;
                            const posGroup = ((_a = sl.position) === null || _a === void 0 ? void 0 : _a.group) || "BENCH";
                            const posLabel = ((_b = sl.position) === null || _b === void 0 ? void 0 : _b.label) || posGroup;
                            const lp = sl.league_player;
                            const name = ((_c = lp === null || lp === void 0 ? void 0 : lp.pro_player) === null || _c === void 0 ? void 0 : _c.name_short) || ((_d = lp === null || lp === void 0 ? void 0 : lp.pro_player) === null || _d === void 0 ? void 0 : _d.name_full) || "";
                            const pos = ((_e = lp === null || lp === void 0 ? void 0 : lp.pro_player) === null || _e === void 0 ? void 0 : _e.position) || posLabel;
                            const pts = extractPts(lp);
                            const isStarter = !["BENCH", "TAXI", "IR", "INJURED", "BN"].includes(posGroup)
                                && posGroup !== "BENCH";
                            const isTaxi = posGroup === "TAXI";
                            return { pos, playerName: name, pts, isStarter, isTaxi };
                        });
                        const starterCount = Math.max(1, slots.filter(s => s.isStarter).length);
                        const activeSlots = slots.filter(s => !s.isTaxi);
                        const optPts = activeSlots
                            .sort((a, b) => b.pts - a.pts)
                            .slice(0, starterCount)
                            .reduce((sum, s) => sum + s.pts, 0);
                        boxscores.push({
                            home: { teamName: team.name, slots, optimalPts: optPts, actualPts: myScore, won },
                            away: { teamName: "", slots: [], optimalPts: 0, actualPts: oppScore, won: !won },
                            week: wk,
                        });
                        wkCount++;
                    }
                    catch { }
                }
                if (wk === weeksPlayed[0])
                    dbg(`W${wk}: ${wkCount}/${teamIds.length} rosters loaded`);
            }
            dbg(`Total boxscore records: ${boxscores.length} (${[...new Set(boxscores.map(b => b.week))].length} weeks)`);
            // Sample pts check
            if (boxscores[0]) {
                const sample = boxscores[0].home.slots.filter(s => s.pts > 0);
                dbg(`Sample W${boxscores[0].week} ${boxscores[0].home.teamName}: ${sample.length} players with pts>0`);
                if (sample[0])
                    dbg(`  e.g. ${sample[0].playerName}: ${sample[0].pts} pts`);
            }
            // Step 5: Compute all awards
            setLoadProgress(5);
            const coreData = { teams, weeklyScores, transactions, trades, boxscores, boxscoresLoaded: true };
            const awards = computeAutoAwards(coreData);
            // Step 6: Validate loaded data
            setLoadProgress(6);
            const validationIssues = validateData(coreData);
            // Save to cache (even with issues — partial data is useful)
            await saveToCache(sess.leagueId, sess.season, coreData);
            setData({ ...coreData, awards, loading: false, validationIssues });
            setPhase("app");
        }
        catch (e) {
            setLoadError(e.message);
        }
    }, []);
    // ── [Boxscores now loaded at startup via loadLeague step 4] ──────────────
    const loadBoxscores = useCallback(async () => {
        if (!data || !session)
            return;
        setData(d => ({ ...d, loadingBoxscores: true }));
        const boxscores = [];
        const gameIds = [...new Set(data.weeklyScores.map(g => g.gameId).filter(Boolean))];
        for (const gameId of gameIds) {
            try {
                const bs = await fetchFF("FetchLeagueBoxscore", { league_id: session.leagueId, fantasy_game_id: gameId });
                const game = bs.game || {};
                ["home", "away"].forEach(side => {
                    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
                    const teamRef = game[side];
                    if (!teamRef)
                        return;
                    const tname = teamRef.name || ((_a = teamRef.team) === null || _a === void 0 ? void 0 : _a.name) || "";
                    const won = side === "home" ? (game.home_result === "WIN" || (((_b = game.away_score) === null || _b === void 0 ? void 0 : _b.value) || 0) < (((_c = game.home_score) === null || _c === void 0 ? void 0 : _c.value) || 0))
                        : (game.away_result === "WIN" || (((_d = game.home_score) === null || _d === void 0 ? void 0 : _d.value) || 0) < (((_e = game.away_score) === null || _e === void 0 ? void 0 : _e.value) || 0));
                    const lineups = bs.lineups || [];
                    const myLineup = lineups.find(l => { var _a, _b; return ((_a = l.team) === null || _a === void 0 ? void 0 : _a.name) === tname || ((_b = l.team) === null || _b === void 0 ? void 0 : _b.id) === teamRef.id; });
                    const slots = [];
                    if (myLineup) {
                        (myLineup.groups || []).forEach(g => {
                            (g.slots || []).forEach(slot => {
                                var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
                                const pos = ((_a = slot.position) === null || _a === void 0 ? void 0 : _a.label) || ((_b = slot.position) === null || _b === void 0 ? void 0 : _b.group) || "";
                                const name = ((_d = (_c = slot.league_player) === null || _c === void 0 ? void 0 : _c.pro_player) === null || _d === void 0 ? void 0 : _d.name_short) || ((_f = (_e = slot.league_player) === null || _e === void 0 ? void 0 : _e.pro_player) === null || _f === void 0 ? void 0 : _f.name_full) || "";
                                const pts = (_k = (_h = (_g = slot.player_points) === null || _g === void 0 ? void 0 : _g.value) !== null && _h !== void 0 ? _h : (_j = slot.points) === null || _j === void 0 ? void 0 : _j.value) !== null && _k !== void 0 ? _k : 0;
                                const isStarter = !["BENCH", "TAXI"].includes(((_l = slot.position) === null || _l === void 0 ? void 0 : _l.group) || "") && (((_m = slot.position) === null || _m === void 0 ? void 0 : _m.start) || 0) > 0;
                                const isTaxi = ((_o = slot.position) === null || _o === void 0 ? void 0 : _o.group) === "TAXI";
                                slots.push({ pos, playerName: name, pts, isStarter, isTaxi });
                            });
                        });
                    }
                    const optimalPts = ((_g = (_f = (side === "home" ? bs.points_home : bs.points_away)) === null || _f === void 0 ? void 0 : _f.optimal) === null || _g === void 0 ? void 0 : _g.value) || 0;
                    boxscores.push({ home: ((_h = game.home) === null || _h === void 0 ? void 0 : _h.name) || "?", away: ((_j = game.away) === null || _j === void 0 ? void 0 : _j.name) || "?", [side + "Name"]: tname, teamName: tname, side, slots, optimalPts, won });
                });
            }
            catch { }
        }
        const updated = { ...data, boxscores, boxscoresLoaded: true, loadingBoxscores: false };
        updated.awards = computeAutoAwards(updated);
        await saveToCache(session.leagueId, session.season, { teams: data.teams, weeklyScores: data.weeklyScores, transactions: data.transactions, boxscores, boxscoresLoaded: true });
        setData(updated);
    }, [data, session]);
    // ── Handlers ────────────────────────────────────────────────────────────
    const handleLogin = (sess) => { setSession(sess); loadLeague(sess); };
    const handleSeasonChange = (yr) => {
        const newSess = { ...session, season: yr };
        setSession(newSess);
        loadLeague(newSess);
    };
    const handleSwitch = (newSess) => {
        const full = { ...session, ...newSess };
        setSession(full);
        setShowSwitcher(false);
        loadLeague(full);
    };
    // ── Render ───────────────────────────────────────────────────────────────
    if (phase === "login")
        return React.createElement(LoginScreen, { onLogin: handleLogin });
    if (phase === "loading")
        return (React.createElement(LoadingScreen, { session: session, progress: loadProgress, error: loadError, debugLog: debugLog, onCancel: () => { setPhase("login"); setLoadError(""); } }));
    const autoCount = Object.keys((data === null || data === void 0 ? void 0 : data.awards) || {}).length;
    return (React.createElement("div", { className: "min-h-screen", style: { background: "#060c16", fontFamily: "'IBM Plex Mono',monospace" } },
        showSwitcher && (React.createElement(QuickSwitcher, { session: session, onSwitch: handleSwitch, onClose: () => setShowSwitcher(false), onLogout: () => { setSession(null); setPhase("login"); setShowSwitcher(false); } })),
        React.createElement("nav", { className: "flex items-center gap-2 px-3 py-2.5 border-b border-slate-800", style: { background: "#070d18" } },
            React.createElement("span", { className: "font-black text-white text-sm tracking-tighter whitespace-nowrap" }, "\uD83C\uDFC8 AWARDS HQ"),
            React.createElement("span", { className: "h-4 w-px bg-slate-800 hidden sm:block" }),
            React.createElement("button", { onClick: () => setShowSwitcher(true), className: "hidden sm:flex items-center gap-1.5 px-2 py-1 rounded-lg transition-all hover:bg-slate-800 group", title: "Liga/Saison wechseln" },
                React.createElement("span", { className: "text-xs font-mono text-slate-500 group-hover:text-slate-300" },
                    "Liga ",
                    session.leagueId),
                React.createElement("span", { className: "text-xs text-slate-700" }, "\u00B7"),
                React.createElement("span", { className: "text-xs font-mono text-slate-500 group-hover:text-slate-300" }, session.season),
                autoCount > 0 && React.createElement("span", { className: "text-xs font-bold px-1.5 py-0.5 rounded-full", style: { background: "#facc1522", color: "#facc15" } },
                    autoCount,
                    " Awards"),
                ((_a = data === null || data === void 0 ? void 0 : data.validationIssues) === null || _a === void 0 ? void 0 : _a.length) > 0 && (React.createElement("span", { className: "text-xs font-bold px-1.5 py-0.5 rounded-full cursor-pointer", style: { background: "#f59e0b22", color: "#f59e0b" }, title: data.validationIssues.map(i => i.msg).join("\n") },
                    "\u26A0 ",
                    data.validationIssues.length,
                    " Hinweis",
                    data.validationIssues.length !== 1 ? "e" : "")),
                React.createElement("span", { className: "text-xs text-slate-600 group-hover:text-slate-400" }, "\u2699")),
            React.createElement("div", { className: "flex-1" }),
            [["awards", "🏆 Awards"], ["stats", "📊 Statistik"]].map(([id, label]) => (React.createElement("button", { key: id, onClick: () => setTab(id), className: "px-3 py-1.5 rounded-lg text-xs font-black transition-all", style: { background: tab === id ? "#facc15" : "transparent", color: tab === id ? "#000" : "#64748b" } }, label))),
            React.createElement("button", { onClick: () => setShowSwitcher(true), className: "px-2 py-1.5 rounded-lg text-xs font-bold hover:bg-slate-800 sm:hidden", style: { color: "#64748b" } }, "\u2699"),
            React.createElement("button", { onClick: () => { setSession(null); setPhase("login"); }, className: "px-2 py-1.5 rounded-lg text-xs font-bold hover:text-white", style: { color: "#374151" }, title: "Ausloggen" }, "\u2715")),
        tab === "awards" && React.createElement(AwardsPage, { data: data, session: session }),
        tab === "stats" && (React.createElement(StatsPage, { data: data, session: session, onSeasonChange: handleSeasonChange, onLoadBoxscores: loadBoxscores }))));
}
(function () {
    window.__mounted = true;
    var root = document.getElementById('root');
    var boot = document.getElementById('boot');
    root.style.display = 'block';
    boot.style.display = 'none';
    ReactDOM.createRoot(root).render(React.createElement(App));
})();
