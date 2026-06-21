"""Customize panel: per-game effect table + mode toggle.

Renders the chosen game's manifest as an editable table:
  Label | Weight | Cooldown | Cost | Votable | Fire
Edits write back to the manifest JSON on disk; a running engine picks them
up via the relay's manifest-edit drain (or on its next restart).

Mode toggle (vote / buy / mixed) writes into QSettings as MODE so the next
engine start uses it; if the engine is already running, the dock-side
mode-set control kind takes effect immediately when connected.
"""
from __future__ import annotations
import json
from pathlib import Path
from typing import Callable, Optional

from PySide6.QtCore import Qt, QSettings, Signal
from PySide6.QtWidgets import (
    QAbstractItemView, QCheckBox, QComboBox, QFrame, QHBoxLayout, QHeaderView,
    QLabel, QLineEdit, QMessageBox, QPushButton, QSizePolicy, QSpinBox,
    QTableWidget, QTableWidgetItem, QTabWidget, QVBoxLayout, QWidget,
)

from companion_crowdplay.games import Game


COLUMNS = ["Effect", "Weight", "Cooldown s", "Bolts", "Votable", "Fire"]


class CustomizePanel(QWidget):
    """Tab body shown when the user clicks 'Customize'."""

    # Emit when the user wants to force-fire (main window forwards to engine).
    fire_requested = Signal(str)  # effect id

    def __init__(self, settings: QSettings, parent=None):
        super().__init__(parent)
        self.settings = settings
        self._game: Optional[Game] = None
        self._manifest_path: Optional[Path] = None
        self._manifest: Optional[dict] = None
        self._build_ui()

    # ── UI build ──────────────────────────────────────────────────────
    def _build_ui(self) -> None:
        v = QVBoxLayout(self); v.setContentsMargins(0, 0, 0, 0); v.setSpacing(8)

        # Mode card
        mode_card = QFrame(); mode_card.setObjectName("card")
        mv = QVBoxLayout(mode_card); mv.setContentsMargins(14, 12, 14, 14); mv.setSpacing(8)
        mv.addWidget(self._h2("Mode"))
        row = QHBoxLayout(); row.setSpacing(6)
        self.btn_vote = QPushButton("Vote"); self.btn_vote.setCheckable(True)
        self.btn_buy = QPushButton("Buy"); self.btn_buy.setCheckable(True)
        self.btn_mixed = QPushButton("Mixed"); self.btn_mixed.setCheckable(True)
        for b, m in ((self.btn_vote, "vote"), (self.btn_buy, "buy"), (self.btn_mixed, "mixed")):
            b.clicked.connect(lambda _=False, mode=m: self._set_mode(mode))
            row.addWidget(b)
        row.addStretch()
        mv.addLayout(row)
        note = QLabel(
            "Vote = 30s chat poll, highest wins. "
            "Buy = viewers spend bolts to fire directly (Crowd-Control style). "
            "Mixed = both at once."
        )
        note.setObjectName("sub"); note.setWordWrap(True)
        mv.addWidget(note)
        v.addWidget(mode_card)

        # Inner tabs - Effects + Triggers
        self.inner_tabs = QTabWidget()
        self.inner_tabs.setDocumentMode(True)
        v.addWidget(self.inner_tabs, 1)

        # ── Effects tab ────────────────────────────────────────────────
        eff_widget = QWidget()
        ev = QVBoxLayout(eff_widget); ev.setContentsMargins(0, 6, 0, 0); ev.setSpacing(8)
        title_row = QHBoxLayout()
        title_row.addStretch()
        self.btn_save = QPushButton("Save effects"); self.btn_save.clicked.connect(self._save_to_disk)
        self.btn_reload = QPushButton("Reload"); self.btn_reload.setObjectName("ghost")
        self.btn_reload.clicked.connect(self.reload)
        title_row.addWidget(self.btn_save); title_row.addWidget(self.btn_reload)
        ev.addLayout(title_row)

        self.table = QTableWidget(0, len(COLUMNS))
        self.table.setHorizontalHeaderLabels(COLUMNS)
        self.table.verticalHeader().setVisible(False)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.AllEditTriggers)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.table.setAlternatingRowColors(True)
        h = self.table.horizontalHeader()
        h.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        for col in range(1, len(COLUMNS)):
            h.setSectionResizeMode(col, QHeaderView.ResizeMode.ResizeToContents)
        self.table.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        ev.addWidget(self.table, 1)

        sub = QLabel("Edit values inline. Toggle Votable to hide an effect from the vote pool. "
                     "Save writes back to the manifest on disk - a running engine picks it up.")
        sub.setObjectName("sub"); sub.setWordWrap(True)
        ev.addWidget(sub)
        self.inner_tabs.addTab(eff_widget, "Effects")

        # ── Triggers tab ───────────────────────────────────────────────
        trig_widget = QWidget()
        tv = QVBoxLayout(trig_widget); tv.setContentsMargins(0, 6, 0, 0); tv.setSpacing(10)
        title2 = QHBoxLayout()
        title2.addStretch()
        self.btn_save_trig = QPushButton("Save triggers"); self.btn_save_trig.clicked.connect(self._save_triggers_to_disk)
        self.btn_reload_trig = QPushButton("Reload"); self.btn_reload_trig.setObjectName("ghost")
        self.btn_reload_trig.clicked.connect(self.reload)
        title2.addWidget(self.btn_save_trig); title2.addWidget(self.btn_reload_trig)
        tv.addLayout(title2)

        # Bits tiers - editable table (min, effect)
        tv.addWidget(self._h2("Bits tiers"))
        self.bits_table = self._make_tier_table(["Min bits", "Effect"])
        tv.addWidget(self.bits_table)
        self._bits_row_btns = self._add_row_buttons(tv, self.bits_table, "bits")

        # TikTok gifts by NAME
        tv.addWidget(self._h2("TikTok gifts (by name)"))
        self.gifts_table = self._make_tier_table(["Gift name", "Effect"])
        tv.addWidget(self.gifts_table)
        self._gifts_row_btns = self._add_row_buttons(tv, self.gifts_table, "gifts")

        # TikTok gift value tiers
        tv.addWidget(self._h2("TikTok gifts (by coin value)"))
        self.giftvalue_table = self._make_tier_table(["Min diamonds", "Effect"])
        tv.addWidget(self.giftvalue_table)
        self._gv_row_btns = self._add_row_buttons(tv, self.giftvalue_table, "giftValueTiers")

        # Likes (perN + effect or random)
        tv.addWidget(self._h2("TikTok likes"))
        like_row = QHBoxLayout(); like_row.setSpacing(8)
        like_row.addWidget(QLabel("Fire every"))
        self.likes_perN = QSpinBox(); self.likes_perN.setRange(1, 10_000); self.likes_perN.setValue(50)
        like_row.addWidget(self.likes_perN)
        like_row.addWidget(QLabel("likes ->"))
        self.likes_effect = QComboBox()
        like_row.addWidget(self.likes_effect, 1)
        self.likes_random = QCheckBox("Random"); self.likes_random.setToolTip("Pick a random votable effect each fire.")
        like_row.addWidget(self.likes_random)
        tv.addLayout(like_row)

        # Single-row trigger blocks: follow / share / sub
        for label, attr in (("Follow", "follow"), ("Share", "share"), ("Subscription", "subscription")):
            tv.addWidget(self._h2(label))
            row = QHBoxLayout(); row.setSpacing(8)
            row.addWidget(QLabel("Fires ->"))
            combo = QComboBox()
            setattr(self, f"trig_{attr}_combo", combo)
            row.addWidget(combo, 1)
            rand = QCheckBox("Random"); rand.setToolTip("Pick a random votable effect each fire.")
            setattr(self, f"trig_{attr}_random", rand)
            row.addWidget(rand)
            tv.addLayout(row)

        tv.addStretch()
        sub2 = QLabel("Save triggers writes back to the manifest on disk. "
                      "Toggle Random to fire a random votable effect instead of a fixed one.")
        sub2.setObjectName("sub"); sub2.setWordWrap(True)
        tv.addWidget(sub2)
        self.inner_tabs.addTab(trig_widget, "Triggers")

    @staticmethod
    def _h2(text: str) -> QLabel:
        lbl = QLabel(text); lbl.setObjectName("h2")
        return lbl

    def _make_tier_table(self, headers: list[str]) -> QTableWidget:
        t = QTableWidget(0, len(headers))
        t.setHorizontalHeaderLabels(headers)
        t.verticalHeader().setVisible(False)
        t.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        t.setAlternatingRowColors(True)
        h = t.horizontalHeader()
        h.setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        h.setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        t.setMinimumHeight(110); t.setMaximumHeight(170)
        return t

    def _add_row_buttons(self, parent_layout: QVBoxLayout, table: QTableWidget, kind: str) -> tuple:
        row = QHBoxLayout(); row.setSpacing(6)
        add = QPushButton("+ Add"); add.setObjectName("ghost")
        rem = QPushButton("Remove selected"); rem.setObjectName("ghost")
        add.clicked.connect(lambda _=False: self._add_tier_row(table, kind))
        rem.clicked.connect(lambda _=False: self._remove_selected(table))
        row.addStretch(); row.addWidget(add); row.addWidget(rem)
        parent_layout.addLayout(row)
        return (add, rem)

    def _all_effect_ids(self) -> list[str]:
        return [e.get("id") for e in (self._manifest or {}).get("effects") or []]

    def _add_tier_row(self, table: QTableWidget, kind: str) -> None:
        r = table.rowCount(); table.insertRow(r)
        if kind == "bits":
            sb = QSpinBox(); sb.setRange(1, 1_000_000); sb.setValue(100)
            table.setCellWidget(r, 0, sb)
        elif kind == "giftValueTiers":
            sb = QSpinBox(); sb.setRange(1, 1_000_000); sb.setValue(30)
            table.setCellWidget(r, 0, sb)
        else:  # gifts by name
            le = QLineEdit(); le.setPlaceholderText("Rose, Lion, ...")
            table.setCellWidget(r, 0, le)
        combo = QComboBox()
        for eid in self._all_effect_ids(): combo.addItem(eid)
        table.setCellWidget(r, 1, combo)

    def _remove_selected(self, table: QTableWidget) -> None:
        sel = sorted({i.row() for i in table.selectedIndexes()}, reverse=True)
        for r in sel:
            table.removeRow(r)

    # ── Public API used by the main window ────────────────────────────
    def load_for(self, game: Game, project_root: Path) -> None:
        """Switch the panel to the given game; reload manifest from disk."""
        self._game = game
        self._manifest_path = project_root / "manifests" / f"{game.slug}.json"
        self.reload()
        self._refresh_mode_buttons()

    def reload(self) -> None:
        if not self._manifest_path or not self._manifest_path.exists():
            self._manifest = None
            self.table.setRowCount(0)
            return
        try:
            self._manifest = json.loads(self._manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            QMessageBox.warning(self, "Customize",
                f"Couldn't read manifest: {e}\nPath: {self._manifest_path}")
            return
        self._render_table()
        self._render_triggers()

    # ── Mode ──────────────────────────────────────────────────────────
    def _set_mode(self, mode: str) -> None:
        self.settings.setValue("crowdplay_mode", mode)
        self._refresh_mode_buttons()

    def _refresh_mode_buttons(self) -> None:
        cur = (self.settings.value("crowdplay_mode", "vote") or "vote").lower()
        for btn, name in ((self.btn_vote, "vote"), (self.btn_buy, "buy"), (self.btn_mixed, "mixed")):
            btn.setChecked(name == cur)

    def current_mode(self) -> str:
        return (self.settings.value("crowdplay_mode", "vote") or "vote").lower()

    # ── Effects table render + save ───────────────────────────────────
    def _render_table(self) -> None:
        effects = list((self._manifest or {}).get("effects") or [])
        self.table.setRowCount(len(effects))
        for r, e in enumerate(effects):
            # Effect (label + id underneath, non-editable)
            label = e.get("label") or e.get("id") or "?"
            cell = QTableWidgetItem(label)
            cell.setData(Qt.ItemDataRole.UserRole, e.get("id"))
            cell.setToolTip(e.get("id") or "")
            cell.setFlags(cell.flags() | Qt.ItemFlag.ItemIsEditable)
            self.table.setItem(r, 0, cell)

            # Numeric columns
            for col, key, default in (
                (1, "weight", 1),
                (2, "cooldownSec", 0),
                (3, "costBolts", 0),
            ):
                sb = QSpinBox(); sb.setRange(0, 999_999)
                v = e.get(key); sb.setValue(int(v) if isinstance(v, (int, float)) else default)
                self.table.setCellWidget(r, col, sb)

            # Votable toggle
            cb = QCheckBox()
            cb.setChecked(e.get("votable", True) is not False)
            cb.setToolTip("If off, this effect is hidden from the 30s vote pool.")
            holder = QWidget(); hl = QHBoxLayout(holder); hl.setContentsMargins(8, 0, 0, 0)
            hl.addWidget(cb); hl.addStretch()
            self.table.setCellWidget(r, 4, holder)

            # Fire
            fire_btn = QPushButton("Fire")
            fire_btn.setMinimumWidth(56)
            eff_id = e.get("id")
            fire_btn.clicked.connect(lambda _=False, _id=eff_id: self.fire_requested.emit(_id or ""))
            fh = QWidget(); fhl = QHBoxLayout(fh); fhl.setContentsMargins(4, 0, 4, 0)
            fhl.addWidget(fire_btn); fhl.addStretch()
            self.table.setCellWidget(r, 5, fh)

    # ── Triggers tab render + save ───────────────────────────────────
    def _render_triggers(self) -> None:
        if not self._manifest:
            return
        triggers = self._manifest.get("triggers") or {}
        effect_ids = self._all_effect_ids()

        def fill_combo(combo: QComboBox, current: str | None) -> None:
            combo.clear()
            for eid in effect_ids: combo.addItem(eid)
            if current and current in effect_ids:
                combo.setCurrentIndex(effect_ids.index(current))

        # Bits tiers
        bits = sorted(triggers.get("bits") or [], key=lambda r: r.get("min") or 0)
        self.bits_table.setRowCount(0)
        for r in bits:
            row = self.bits_table.rowCount(); self.bits_table.insertRow(row)
            sb = QSpinBox(); sb.setRange(1, 1_000_000); sb.setValue(int(r.get("min") or 0))
            self.bits_table.setCellWidget(row, 0, sb)
            cb = QComboBox(); fill_combo(cb, r.get("effect"))
            self.bits_table.setCellWidget(row, 1, cb)

        # Gifts by name
        gifts = list(triggers.get("gifts") or [])
        self.gifts_table.setRowCount(0)
        for r in gifts:
            row = self.gifts_table.rowCount(); self.gifts_table.insertRow(row)
            le = QLineEdit(); le.setText(r.get("match") or "")
            self.gifts_table.setCellWidget(row, 0, le)
            cb = QComboBox(); fill_combo(cb, r.get("effect"))
            self.gifts_table.setCellWidget(row, 1, cb)

        # Gift value tiers
        gv = sorted(triggers.get("giftValueTiers") or [], key=lambda r: r.get("minDiamonds") or 0)
        self.giftvalue_table.setRowCount(0)
        for r in gv:
            row = self.giftvalue_table.rowCount(); self.giftvalue_table.insertRow(row)
            sb = QSpinBox(); sb.setRange(1, 1_000_000); sb.setValue(int(r.get("minDiamonds") or 0))
            self.giftvalue_table.setCellWidget(row, 0, sb)
            cb = QComboBox(); fill_combo(cb, r.get("effect"))
            self.giftvalue_table.setCellWidget(row, 1, cb)

        # Likes
        likes = triggers.get("likes") or {}
        self.likes_perN.setValue(int(likes.get("perN") or 50))
        fill_combo(self.likes_effect, likes.get("effect"))
        self.likes_random.setChecked(bool(likes.get("random")))

        # Follow / share / subscription
        for attr in ("follow", "share", "subscription"):
            rule = triggers.get(attr) or {}
            combo = getattr(self, f"trig_{attr}_combo")
            fill_combo(combo, rule.get("effect"))
            random_cb = getattr(self, f"trig_{attr}_random")
            random_cb.setChecked(bool(rule.get("random")))

    def _save_triggers_to_disk(self) -> None:
        if not self._manifest or not self._manifest_path:
            return
        triggers = self._manifest.setdefault("triggers", {})

        # Bits tiers
        out_bits = []
        for r in range(self.bits_table.rowCount()):
            sb = self.bits_table.cellWidget(r, 0); cb = self.bits_table.cellWidget(r, 1)
            if sb and cb and cb.currentText():
                out_bits.append({"min": int(sb.value()), "effect": cb.currentText()})
        triggers["bits"] = out_bits

        # Gifts by name
        out_gifts = []
        for r in range(self.gifts_table.rowCount()):
            le = self.gifts_table.cellWidget(r, 0); cb = self.gifts_table.cellWidget(r, 1)
            if le and cb and le.text().strip() and cb.currentText():
                out_gifts.append({"match": le.text().strip(), "effect": cb.currentText()})
        triggers["gifts"] = out_gifts

        # Gift value tiers
        out_gv = []
        for r in range(self.giftvalue_table.rowCount()):
            sb = self.giftvalue_table.cellWidget(r, 0); cb = self.giftvalue_table.cellWidget(r, 1)
            if sb and cb and cb.currentText():
                out_gv.append({"minDiamonds": int(sb.value()), "effect": cb.currentText()})
        triggers["giftValueTiers"] = out_gv

        # Likes
        likes = {"perN": int(self.likes_perN.value())}
        if self.likes_random.isChecked():
            likes["random"] = True
        else:
            likes["effect"] = self.likes_effect.currentText()
        triggers["likes"] = likes

        # Follow / share / subscription
        for attr in ("follow", "share", "subscription"):
            combo = getattr(self, f"trig_{attr}_combo")
            random_cb = getattr(self, f"trig_{attr}_random")
            if random_cb.isChecked():
                triggers[attr] = {"random": True}
            elif combo.currentText():
                triggers[attr] = {"effect": combo.currentText()}

        try:
            self._manifest_path.write_text(
                json.dumps(self._manifest, indent=2) + "\n", encoding="utf-8"
            )
        except OSError as e:
            QMessageBox.warning(self, "Customize", f"Save failed: {e}")
            return
        QMessageBox.information(self, "Customize", "Triggers saved.")

    def _save_to_disk(self) -> None:
        if not self._manifest or not self._manifest_path:
            return
        effects = self._manifest.get("effects") or []
        for r, e in enumerate(effects):
            lbl_item = self.table.item(r, 0)
            if lbl_item:
                e["label"] = lbl_item.text()
            # numeric cells
            for col, key in ((1, "weight"), (2, "cooldownSec"), (3, "costBolts")):
                w = self.table.cellWidget(r, col)
                if isinstance(w, QSpinBox):
                    e[key] = int(w.value())
            # votable cell
            holder = self.table.cellWidget(r, 4)
            if holder:
                cb = holder.findChild(QCheckBox)
                if cb:
                    e["votable"] = bool(cb.isChecked())
        try:
            self._manifest_path.write_text(
                json.dumps(self._manifest, indent=2) + "\n", encoding="utf-8"
            )
        except OSError as e:
            QMessageBox.warning(self, "Customize", f"Save failed: {e}")
            return
        QMessageBox.information(self, "Customize",
            "Saved. If the engine is running, the dock relay will push the new "
            "manifest on its next tick (~1.5s).")
