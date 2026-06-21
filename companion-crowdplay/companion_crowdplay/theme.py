"""Qt stylesheet (qss) - dark gradient, violet/teal aurora accents, Segoe UI.

Tuned for a tab-based main window: bigger touch targets, clearer typography
hierarchy, more breathing room between cards. Status pips include text
labels so the dot + colour aren't doing all the work.
"""

QSS = """
* { font-family: "Segoe UI", "Inter", -apple-system, Arial, sans-serif; }

QMainWindow, QWidget#central {
    background-color: #0a0b12;
}

/* ── Typography ─────────────────────────────────────────────────────── */
QLabel { color: #f5f6fb; font-size: 13px; }
QLabel#h1 { font-size: 22px; font-weight: 800; color: #f5f6fb; letter-spacing: 0.01em; }
QLabel#h2 { font-size: 11px; font-weight: 800; color: #9a82ff; letter-spacing: 0.14em; text-transform: uppercase; }
QLabel#h3 { font-size: 14px; font-weight: 700; color: #f5f6fb; }
QLabel#sub { color: #aeb0c4; font-size: 12px; }
QLabel#micro { color: #aeb0c4; font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; font-weight: 700; }
QLabel#mono { font-family: "Consolas", "Cascadia Code", monospace; color: #cfd2dc; font-size: 12px; }
QLabel#hero { font-size: 28px; font-weight: 800; color: #f5f6fb; }

/* ── Cards ──────────────────────────────────────────────────────────── */
#card {
    background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
        stop:0 rgba(22,25,41,0.92), stop:1 rgba(12,13,22,0.94));
    border: 1px solid rgba(154,130,255,0.22);
    border-radius: 16px;
}
#cardAccent {
    background: qlineargradient(x1:0, y1:0, x2:1, y2:1,
        stop:0 rgba(124,92,255,0.18), stop:1 rgba(34,211,238,0.10));
    border: 1px solid rgba(154,130,255,0.40);
    border-radius: 16px;
}

/* ── Tab bar (main navigation) ──────────────────────────────────────── */
QTabWidget#mainTabs::pane {
    border: none;
    border-top: 1px solid rgba(154,130,255,0.20);
    background: transparent;
    margin-top: -1px;
}
QTabWidget#mainTabs QTabBar { qproperty-drawBase: 0; }
QTabBar::tab {
    color: #aeb0c4;
    background: transparent;
    padding: 10px 20px;
    margin-right: 2px;
    border: none;
    border-bottom: 2px solid transparent;
    font-size: 13px;
    font-weight: 650;
    min-width: 80px;
}
QTabBar::tab:hover { color: #f5f6fb; background: rgba(124,92,255,0.06); border-radius: 8px 8px 0 0; }
QTabBar::tab:selected {
    color: #f5f6fb;
    border-bottom: 2px solid #9a82ff;
}

/* Inner sub-tab variant (used inside Triggers / Customize) */
QTabWidget::pane { border: none; background: transparent; }

/* ── Status pip + badge ─────────────────────────────────────────────── */
#pip {
    background-color: #6b6f86;
    border-radius: 6px;
    min-width: 12px; min-height: 12px; max-width: 12px; max-height: 12px;
}
#pip[state="ok"] { background-color: #5bff95; }
#pip[state="warn"] { background-color: #ffb454; }
#pip[state="err"] { background-color: #ff6b6b; }

#badge {
    padding: 4px 10px; border-radius: 999px;
    background: rgba(124,92,255,0.18); color: #d4c2ff;
    border: 1px solid rgba(154,130,255,0.32);
    font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
}
#badge[state="ok"]  { background: rgba(91,255,149,0.16); color: #5bff95; border-color: rgba(91,255,149,0.32); }
#badge[state="warn"]{ background: rgba(255,180,84,0.16); color: #ffb454; border-color: rgba(255,180,84,0.32); }
#badge[state="err"] { background: rgba(255,107,107,0.16); color: #ff6b6b; border-color: rgba(255,107,107,0.32); }

#checkRow { padding: 4px 0; }
#checkMark { font-family: "Segoe UI Symbol"; font-size: 14px; font-weight: 700; min-width: 22px; }
#checkMark[state="ok"] { color: #5bff95; }
#checkMark[state="err"] { color: #ff6b6b; }
#checkMark[state="warn"] { color: #ffb454; }
#checkMark[state="off"] { color: #6b6f86; }

/* ── Buttons ────────────────────────────────────────────────────────── */
QPushButton {
    color: #f5f6fb;
    background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
        stop:0 rgba(124,92,255,0.30), stop:1 rgba(124,92,255,0.12));
    border: 1px solid rgba(154,130,255,0.40);
    border-radius: 10px; padding: 10px 16px; font-weight: 650; font-size: 13px;
}
QPushButton:hover { background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
    stop:0 rgba(124,92,255,0.45), stop:1 rgba(124,92,255,0.20)); }
QPushButton:pressed { padding-top: 11px; padding-bottom: 9px; }
QPushButton:disabled { color: rgba(245,246,251,0.45);
    background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.10); }

QPushButton#hero {
    background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
        stop:0 rgba(91,255,149,0.40), stop:1 rgba(91,255,149,0.18));
    border-color: rgba(91,255,149,0.55);
    padding: 18px 32px; font-size: 16px; font-weight: 800;
    min-height: 22px; border-radius: 14px;
}
QPushButton#stop {
    background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
        stop:0 rgba(255,107,107,0.40), stop:1 rgba(255,107,107,0.18));
    border-color: rgba(255,107,107,0.55);
    padding: 18px 32px; font-size: 16px; font-weight: 800;
    min-height: 22px; border-radius: 14px;
}
QPushButton#ghost {
    background: rgba(255,255,255,0.04);
    border-color: rgba(255,255,255,0.10);
    color: #cfd2dc;
}
QPushButton#ghost:hover { color: #f5f6fb; background: rgba(255,255,255,0.08); }
QPushButton#danger {
    background: qlineargradient(x1:0, y1:0, x2:0, y2:1,
        stop:0 rgba(255,107,107,0.26), stop:1 rgba(255,107,107,0.10));
    border-color: rgba(255,107,107,0.40);
}

/* ── Inputs ─────────────────────────────────────────────────────────── */
QComboBox {
    color: #f5f6fb; background-color: #14151f;
    border: 1px solid rgba(154,130,255,0.30); border-radius: 10px;
    padding: 10px 32px 10px 12px; font-size: 14px;
}
QComboBox#hero { padding: 14px 36px 14px 16px; font-size: 16px; font-weight: 650; min-width: 340px; }
QComboBox::drop-down { border: none; width: 28px; }
QComboBox::down-arrow {
    image: none;
    border-top: 6px solid #9a82ff;
    border-left: 5px solid transparent;
    border-right: 5px solid transparent;
    width: 0; height: 0;
}
QComboBox QAbstractItemView {
    background-color: #14151f; color: #f5f6fb;
    border: 1px solid rgba(154,130,255,0.40); border-radius: 10px;
    selection-background-color: rgba(124,92,255,0.30);
    padding: 4px;
}

QLineEdit {
    color: #f5f6fb; background-color: rgba(0,0,0,0.34);
    border: 1px solid rgba(154,130,255,0.24); border-radius: 10px;
    padding: 10px 12px; font-size: 13px;
}
QLineEdit:focus { border-color: #7c5cff; }

QSpinBox {
    color: #f5f6fb; background-color: rgba(0,0,0,0.30);
    border: 1px solid rgba(154,130,255,0.24); border-radius: 8px;
    padding: 6px 8px; font-size: 13px;
}
QSpinBox:focus { border-color: #7c5cff; }
QSpinBox::up-button, QSpinBox::down-button { width: 16px; }

QCheckBox { color: #f5f6fb; font-size: 13px; spacing: 8px; }
QCheckBox::indicator {
    width: 18px; height: 18px;
    background: rgba(0,0,0,0.32);
    border: 1px solid rgba(154,130,255,0.40); border-radius: 5px;
}
QCheckBox::indicator:checked {
    background: qlineargradient(x1:0, y1:0, x2:1, y2:1, stop:0 #7c5cff, stop:1 #22d3ee);
    border-color: #9a82ff;
}

/* ── Tables ─────────────────────────────────────────────────────────── */
QTableWidget {
    background: rgba(0,0,0,0.18);
    alternate-background-color: rgba(124,92,255,0.04);
    border: 1px solid rgba(154,130,255,0.16);
    border-radius: 10px;
    gridline-color: rgba(154,130,255,0.10);
    color: #f5f6fb;
    selection-background-color: rgba(124,92,255,0.20);
    font-size: 13px;
}
QHeaderView::section {
    background: rgba(124,92,255,0.10);
    color: #9a82ff;
    border: none;
    border-bottom: 1px solid rgba(154,130,255,0.20);
    padding: 8px 10px;
    font-weight: 700; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
}
QTableWidget::item { padding: 6px 8px; }

QScrollArea { border: none; background: transparent; }
QScrollBar:vertical {
    background: transparent; width: 10px; margin: 4px 2px 4px 0;
}
QScrollBar::handle:vertical {
    background: rgba(154,130,255,0.35); min-height: 30px; border-radius: 4px;
}
QScrollBar::handle:vertical:hover { background: rgba(154,130,255,0.55); }
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical { background: transparent; }

/* ── Log view ───────────────────────────────────────────────────────── */
QPlainTextEdit#log {
    background-color: #06070d;
    color: #cfd2dc;
    border: 1px solid rgba(154,130,255,0.16); border-radius: 12px;
    padding: 10px;
    font-family: "Consolas", "Cascadia Code", monospace;
    font-size: 12px;
}

/* ── Misc ───────────────────────────────────────────────────────────── */
QStatusBar { color: #aeb0c4; }
QStatusBar::item { border: none; }
QToolTip {
    background-color: #14151f; color: #f5f6fb;
    border: 1px solid rgba(154,130,255,0.30); padding: 7px 10px;
    border-radius: 6px;
}

QFrame#hr {
    background: rgba(154,130,255,0.16);
    max-height: 1px; min-height: 1px;
    border: none;
}
"""
