"use strict";

/*
 * EdgeDrag Desktop Switcher — OSD on toggle (“switch on edge”)
 * - Switch desktops when the cursor hits a configured screen edge WHILE a drag is active.
 * - Drag sources: window interactive move/resize, compositor DnD icon (files/text), or “switch on edge” hotkey.
 * - Edge activation/reactivation delays come from Screen Edges settings.
 * - Edges are assigned via X-KWin-Border-Activate (Screen Edges KCM).
 * - Hotkey is a KWin global shortcut (change in System Settings → Shortcuts → KWin).
 */

const SCRIPT = "edgedrag-desktop-switcher";
function log(m) { print("[" + SCRIPT + "] " + m); }

// ---- setting (single) ----
let showToggleOSD = readConfig("ShowToggleOSD", true);

// ---- edges: state + helpers (declare BEFORE using anywhere) ----
let registeredEdges = [];

function readPickedEdges() {
    try {
        const arr = readConfig("BorderConfig", []);
        if (arr && typeof arr.length === "number") return Array.prototype.slice.call(arr);
    } catch (_) {}
    return [];
}
function arraysEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; ++i) if (a[i] !== b[i]) return false;
    return true;
}
function unregisterAllEdges() {
    if (typeof unregisterScreenEdge === "function") {
        registeredEdges.forEach((e) => unregisterScreenEdge(e));
    }
    registeredEdges = [];
}
function registerEdges(edges) {
    unregisterAllEdges();
    if (!edges || !edges.length) {
        edges = [
            KWin.ElectricLeft, KWin.ElectricRight, KWin.ElectricTop, KWin.ElectricBottom,
            KWin.ElectricTopLeft, KWin.ElectricTopRight, KWin.ElectricBottomLeft, KWin.ElectricBottomRight
        ];
    }
    edges.forEach((e) => {
        const ok = registerScreenEdge(e, () => onEdge(e));
        if (ok) registeredEdges.push(e);
    });
}

// ---- react to KCM Apply (our checkbox + Screen Edges) ----
if (typeof options !== "undefined" && options.configChanged && options.configChanged.connect) {
    options.configChanged.connect(() => {
        showToggleOSD = readConfig("ShowToggleOSD", true);
        const picked = readPickedEdges();
        if (!arraysEqual(picked, registeredEdges)) registerEdges(picked);
    });
}

// ---- OSD (Plasma osdService) ----
function showOSD(text) {
    if (!showToggleOSD) return;
    try {
        callDBus("org.kde.plasmashell", "/org/kde/osdService",
            "org.kde.osdService", "showText",
            "preferences-system-windows", text);
    } catch (_) {
        if (workspace && typeof workspace.showOnScreenMessage === "function") {
            try { workspace.showOnScreenMessage(text); } catch (__) {}
        }
    }
}

// ---- drag state ----
let draggingWindow = false;
let draggingDnd    = false;
let switchOnEdge   = false;  // renamed from “manual drag”

const dndWindows = new Set();
function isDragging() { return draggingWindow || draggingDnd || switchOnEdge; }

function wireWindow(w) {
    if (w.interactiveMoveResizeStarted && w.interactiveMoveResizeStarted.connect)
        w.interactiveMoveResizeStarted.connect(() => { draggingWindow = true; });

    if (w.interactiveMoveResizeFinished && w.interactiveMoveResizeFinished.connect)
        w.interactiveMoveResizeFinished.connect(() => { draggingWindow = false; });

    try {
        if (w.dndIcon) {
            dndWindows.add(w);
            draggingDnd = dndWindows.size > 0;
            if (w.closed && w.closed.connect) {
                w.closed.connect(() => {
                    dndWindows.delete(w);
                    draggingDnd = dndWindows.size > 0;
                });
            }
        }
    } catch (_) {}
}
(workspace.stackingOrder || []).forEach(wireWindow);
workspace.windowAdded?.connect?.(wireWindow);
workspace.windowRemoved?.connect?.((w) => {
    if (dndWindows.delete(w)) draggingDnd = dndWindows.size > 0;
});

// ---- “switch on edge” hotkey (KGlobalAccel) ----
// Sets a default if none exists; users change it in Shortcuts → KWin.
if (typeof registerShortcut === "function") {
    registerShortcut(
        "EdgeDragToggleSwitchOnEdge",             // stable id
        "EdgeDrag: Switch on edge (toggle)",      // shows in KWin shortcuts
        "Meta+Alt+D",                             // default (used if no user override exists)
        onTogglePulse
    );
}
const QUIET_GAP_MS = 300; // ignore auto-repeat; OFF only if next press after this gap
let lastPulse = 0;

function onTogglePulse() {
    const now = Date.now();
    if (!switchOnEdge) {
        switchOnEdge = true;
        lastPulse = now;
        showOSD("EdgeDrag: switch on edge on");
        return;
    }
    if (now - lastPulse >= QUIET_GAP_MS) {
        switchOnEdge = false;
        showOSD("EdgeDrag: switch on edge off");
    }
    lastPulse = now;
}

// ---- edge handling ----
let lastPos = workspace.cursorPos || { x: 0, y: 0 };
let lastDelta = { dx: 0, dy: 0 };
workspace.cursorPosChanged?.connect?.(() => {
    const p = workspace.cursorPos || lastPos;
    lastDelta = { dx: p.x - lastPos.x, dy: p.y - lastPos.y };
    lastPos = p;
});
function dirForEdge(edge) {
    switch (edge) {
        case KWin.ElectricLeft:   return "left";
        case KWin.ElectricRight:  return "right";
        case KWin.ElectricTop:    return "up";
        case KWin.ElectricBottom: return "down";
        case KWin.ElectricTopLeft:     return Math.abs(lastDelta.dx) >= Math.abs(lastDelta.dy) ? "left"  : "up";
        case KWin.ElectricBottomLeft:  return Math.abs(lastDelta.dx) >= Math.abs(lastDelta.dy) ? "left"  : "down";
        case KWin.ElectricTopRight:    return Math.abs(lastDelta.dx) >= Math.abs(lastDelta.dy) ? "right" : "up";
        case KWin.ElectricBottomRight: return Math.abs(lastDelta.dx) >= Math.abs(lastDelta.dy) ? "right" : "down";
        default: return null;
    }
}
function onEdge(edge) {
    if (!isDragging()) return;
    const dir = dirForEdge(edge);
    if (!dir) return;

    if      (dir === "left"  && typeof workspace.slotSwitchDesktopLeft  === "function") workspace.slotSwitchDesktopLeft();
    else if (dir === "right" && typeof workspace.slotSwitchDesktopRight === "function") workspace.slotSwitchDesktopRight();
    else if (dir === "up"    && typeof workspace.slotSwitchDesktopUp    === "function") workspace.slotSwitchDesktopUp();
    else if (dir === "down"  && typeof workspace.slotSwitchDesktopDown  === "function") workspace.slotSwitchDesktopDown();
}

// init
registerEdges(readPickedEdges());
log("loaded");
