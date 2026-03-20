import { useState, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://oscdvtsfultfmjcyrhtn.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9zY2R2dHNmdWx0Zm1qY3lyaHRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMTY2MjEsImV4cCI6MjA4OTU5MjYyMX0.j5ecr5L2XxOY2921SeE54xpABthpH2Ub5Yw_TGeHNsk";
const ADMIN_PIN = "1234"; // Change this to your preferred PIN
const MONTHS_TO_SHOW = 6;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─── Date helpers ────────────────────────────────────────────────────────────

function getWeekends(year, month) {
  const weekends = [];
  const date = new Date(year, month, 1);
  while (date.getMonth() === month) {
    if (date.getDay() === 6) {
      const sat = new Date(date);
      const sun = new Date(date);
      sun.setDate(sun.getDate() + 1);
      const id = `${year}-${String(month + 1).padStart(2, "0")}-${String(sat.getDate()).padStart(2, "0")}`;
      weekends.push({
        id,
        sat,
        sun,
        label: `${sat.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${sun.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
        monthLabel: sat.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
      });
    }
    date.setDate(date.getDate() + 1);
  }
  return weekends;
}

function getAllUpcomingWeekends() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const result = [];
  for (let i = 0; i < MONTHS_TO_SHOW; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
    getWeekends(d.getFullYear(), d.getMonth())
      .filter((w) => w.sun >= today)
      .forEach((w) => result.push(w));
  }
  return result;
}

function groupByMonth(weekends) {
  const map = {};
  weekends.forEach((w) => {
    if (!map[w.monthLabel]) map[w.monthLabel] = [];
    map[w.monthLabel].push(w);
  });
  return Object.entries(map);
}

// ─── Status config ────────────────────────────────────────────────────────────

const STATUS = {
  open:      { label: "Available",  dot: "#4a7c59", bg: "#eaf3ec", color: "#2d5e3f" },
  requested: { label: "Requested",  dot: "#b8860b", bg: "#fdf4e3", color: "#7a5c1e" },
  booked:    { label: "Booked",     dot: "#c0392b", bg: "#f5eaea", color: "#8b3a3a" },
  blocked:   { label: "Unavailable",dot: "#555",    bg: "#f0f0f0", color: "#555"    },
};

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [bookings, setBookings] = useState({});       // { weekendId: { status, note } }
  const [requests, setRequests] = useState([]);       // array of request rows
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminInput, setAdminInput] = useState("");
  const [adminError, setAdminError] = useState(false);
  const [view, setView] = useState("calendar");       // "calendar" | "admin"
  const [requestModal, setRequestModal] = useState(null); // weekend obj
  const [reqName, setReqName] = useState("");
  const [reqNote, setReqNote] = useState("");
  const [reqSent, setReqSent] = useState(false);
  const [editWeekend, setEditWeekend] = useState(null);
  const [editNote, setEditNote] = useState("");
  const [editStatus, setEditStatus] = useState("open");
  const [bulkStatus, setBulkStatus] = useState("open");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  const allWeekends = getAllUpcomingWeekends();

  // ── Load data ──
  useEffect(() => {
    loadAll();
    // Realtime subscription
    const channel = supabase
      .channel("cabin-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "bookings" }, loadBookings)
      .on("postgres_changes", { event: "*", schema: "public", table: "requests" }, loadRequests)
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, []);

  async function loadAll() {
    setLoading(true);
    await Promise.all([loadBookings(), loadRequests()]);
    setLoading(false);
  }

  async function loadBookings() {
    const { data } = await supabase.from("bookings").select("*");
    if (data) {
      const map = {};
      data.forEach((r) => { map[r.id] = { status: r.status, note: r.note }; });
      setBookings(map);
    }
  }

  async function loadRequests() {
    const { data } = await supabase.from("requests").select("*").order("created_at", { ascending: false });
    if (data) setRequests(data);
  }

  // ── Helpers ──
  function showToast(msg, type = "success") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  function getStatus(id) { return bookings[id]?.status || "open"; }
  function getNote(id)   { return bookings[id]?.note   || ""; }

  function pendingCount() {
    return requests.filter((r) => r.status === "pending").length;
  }

  // ── Admin login ──
  function tryAdmin() {
    if (adminInput === ADMIN_PIN) {
      setIsAdmin(true); setAdminError(false); setView("calendar");
    } else {
      setAdminError(true);
    }
    setAdminInput("");
  }

  // ── Guest: submit request ──
  async function submitRequest() {
    if (!reqName.trim()) return;
    setSaving(true);
    const wid = requestModal.id;

    // Insert request row
    const { error: rErr } = await supabase.from("requests").insert({
      weekend_id: wid,
      guest_name: reqName.trim(),
      note: reqNote.trim(),
      status: "pending",
    });

    if (!rErr) {
      // Mark weekend as requested
      await upsertBooking(wid, "requested", getNote(wid));
      setReqSent(true);
      showToast("Request sent! Patrick will confirm soon.");
    }
    setSaving(false);
  }

  // ── Admin: upsert booking ──
  async function upsertBooking(id, status, note) {
    await supabase.from("bookings").upsert({ id, status, note });
    await loadBookings();
  }

  // ── Admin: approve/decline request ──
  async function resolveRequest(req, decision) {
    setSaving(true);
    await supabase.from("requests").update({ status: decision }).eq("id", req.id);

    if (decision === "approved") {
      await upsertBooking(req.weekend_id, "booked", req.guest_name);
      showToast(`Approved for ${req.guest_name} 🎉`);
    } else {
      // If no other pending requests for this weekend, reopen it
      const remaining = requests.filter(
        (r) => r.weekend_id === req.weekend_id && r.id !== req.id && r.status === "pending"
      );
      if (remaining.length === 0) await upsertBooking(req.weekend_id, "open", "");
      showToast(`Declined.`);
    }
    await loadRequests();
    setSaving(false);
  }

  // ── Admin: bulk set all open weekends ──
  async function bulkSetWeekends(targetStatus) {
    setSaving(true);
    const ops = allWeekends.map((w) => ({
      id: w.id,
      status: targetStatus,
      note: getNote(w.id),
    }));
    await supabase.from("bookings").upsert(ops);
    await loadBookings();
    showToast(`All weekends set to ${STATUS[targetStatus].label}`);
    setSaving(false);
  }

  // ── Admin: save individual edit ──
  async function saveEdit() {
    if (!editWeekend) return;
    setSaving(true);
    await upsertBooking(editWeekend.id, editStatus, editNote);
    showToast("Saved!");
    setEditWeekend(null);
    setSaving(false);
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  const months = groupByMonth(allWeekends);

  return (
    <div style={S.page}>
      <style>{CSS}</style>

      {/* Toast */}
      {toast && (
        <div style={{ ...S.toast, background: toast.type === "error" ? "#8b3a3a" : "#2d5e3f" }}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={S.header}>
        <div style={S.treeLine}>🌲🌲🌲</div>
        <h1 style={S.title}>The Putnam Valley Cabin</h1>
        <p style={S.subtitle}>Check a weekend. Put in a request. We'll take it from there.</p>
      </div>

      {/* Nav tabs (admin only) */}
      {isAdmin && (
        <div style={S.tabs}>
          <button className={`tab ${view === "calendar" ? "active" : ""}`} onClick={() => setView("calendar")}>
            Calendar
          </button>
          <button className={`tab ${view === "admin" ? "active" : ""}`} onClick={() => setView("admin")}>
            Requests {pendingCount() > 0 && <span style={S.badge}>{pendingCount()}</span>}
          </button>
          <button className={`tab ${view === "setup" ? "active" : ""}`} onClick={() => setView("setup")}>
            Setup
          </button>
          <button className="tab" style={{ marginLeft: "auto", opacity: 0.5 }}
            onClick={() => { setIsAdmin(false); setView("calendar"); }}>
            Exit
          </button>
        </div>
      )}

      {loading ? (
        <div style={S.loading}>Loading cabin calendar…</div>
      ) : (
        <>
          {/* ── CALENDAR VIEW ── */}
          {view === "calendar" && (
            <div style={S.calendar}>
              {months.map(([month, weekends]) => (
                <div key={month} style={S.monthBlock}>
                  <h2 style={S.monthLabel}>{month}</h2>
                  {weekends.map((w) => {
                    const st = getStatus(w.id);
                    const note = getNote(w.id);
                    const s = STATUS[st];
                    const canRequest = st === "open";
                    const isEditing = editWeekend?.id === w.id;
                    return (
                      <div key={w.id}>
                        <div
                          className={`weekend-row ${canRequest && !isAdmin ? "clickable" : ""} ${isAdmin ? "admin-clickable" : ""}`}
                          style={{ background: s.bg, borderColor: isEditing ? "#b8860b" : "transparent" }}
                          onClick={() => {
                            if (isAdmin) {
                              setEditWeekend(w);
                              setEditNote(note);
                              setEditStatus(st);
                            } else if (canRequest) {
                              setRequestModal(w);
                              setReqName(""); setReqNote(""); setReqSent(false);
                            }
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <div className="dot" style={{ background: s.dot }} />
                            <div>
                              <div style={S.weekendLabel}>{w.label}</div>
                              {note && <div style={S.weekendNote}>{note}</div>}
                            </div>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ ...S.statusPill, color: s.color }}>{s.label}</span>
                            {canRequest && !isAdmin && (
                              <span style={S.requestCta}>Request →</span>
                            )}
                          </div>
                        </div>

                        {/* Inline edit panel (admin) */}
                        {isAdmin && isEditing && (
                          <div style={S.editPanel}>
                            <div style={S.editTitle}>Editing: {w.label}</div>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                              {Object.entries(STATUS).map(([key, sv]) => (
                                <button key={key}
                                  className="status-btn"
                                  style={{
                                    background: editStatus === key ? sv.dot : sv.bg,
                                    color: editStatus === key ? "#fff" : sv.color,
                                    border: `2px solid ${sv.dot}`,
                                    fontWeight: editStatus === key ? 700 : 400,
                                  }}
                                  onClick={() => setEditStatus(key)}>
                                  {sv.label}
                                </button>
                              ))}
                            </div>
                            <input style={S.noteInput} value={editNote}
                              onChange={(e) => setEditNote(e.target.value)}
                              placeholder="Note (e.g. 'Sarah & Mike', 'Family visit')…" />
                            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                              <button className="status-btn" style={S.saveBtn} onClick={saveEdit} disabled={saving}>
                                {saving ? "Saving…" : "Save"}
                              </button>
                              <button className="status-btn" style={S.cancelBtn} onClick={() => setEditWeekend(null)}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          {/* ── REQUESTS VIEW (admin) ── */}
          {view === "admin" && isAdmin && (
            <div style={S.calendar}>
              <h2 style={S.monthLabel}>Pending Requests</h2>
              {requests.filter((r) => r.status === "pending").length === 0 && (
                <div style={S.empty}>No pending requests right now.</div>
              )}
              {requests.filter((r) => r.status === "pending").map((r) => {
                const w = allWeekends.find((wk) => wk.id === r.weekend_id);
                return (
                  <div key={r.id} style={S.requestCard}>
                    <div style={S.reqTop}>
                      <div>
                        <div style={S.reqName}>{r.guest_name}</div>
                        <div style={S.reqWeekend}>{w ? w.label : r.weekend_id}</div>
                        {r.note && <div style={S.reqUserNote}>"{r.note}"</div>}
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button className="status-btn" style={S.approveBtn}
                          onClick={() => resolveRequest(r, "approved")} disabled={saving}>
                          ✓ Approve
                        </button>
                        <button className="status-btn" style={S.declineBtn}
                          onClick={() => resolveRequest(r, "declined")} disabled={saving}>
                          ✗ Decline
                        </button>
                      </div>
                    </div>
                    <div style={S.reqDate}>
                      Submitted {new Date(r.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                );
              })}

              {requests.filter((r) => r.status !== "pending").length > 0 && (
                <>
                  <h2 style={{ ...S.monthLabel, marginTop: 32 }}>Past Requests</h2>
                  {requests.filter((r) => r.status !== "pending").map((r) => {
                    const w = allWeekends.find((wk) => wk.id === r.weekend_id);
                    return (
                      <div key={r.id} style={{ ...S.requestCard, opacity: 0.6 }}>
                        <div style={S.reqTop}>
                          <div>
                            <div style={S.reqName}>{r.guest_name}</div>
                            <div style={S.reqWeekend}>{w ? w.label : r.weekend_id}</div>
                          </div>
                          <span style={{
                            fontFamily: "'Lato',sans-serif", fontSize: 12, fontWeight: 700,
                            textTransform: "uppercase", letterSpacing: "0.06em",
                            color: r.status === "approved" ? "#2d5e3f" : "#8b3a3a",
                          }}>
                            {r.status}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}

          {/* ── SETUP VIEW (admin) ── */}
          {view === "setup" && isAdmin && (
            <div style={S.calendar}>
              <h2 style={S.monthLabel}>Bulk Setup</h2>
              <p style={S.setupDesc}>
                Quickly set the default status for all upcoming weekends at once, then fine-tune individually on the Calendar tab.
              </p>
              <div style={S.bulkRow}>
                {Object.entries(STATUS).map(([key, sv]) => (
                  <button key={key}
                    className="status-btn"
                    style={{
                      background: bulkStatus === key ? sv.dot : sv.bg,
                      color: bulkStatus === key ? "#fff" : sv.color,
                      border: `2px solid ${sv.dot}`,
                      fontWeight: bulkStatus === key ? 700 : 400,
                      padding: "10px 18px",
                    }}
                    onClick={() => setBulkStatus(key)}>
                    {sv.label}
                  </button>
                ))}
              </div>
              <button className="status-btn" style={{ ...S.saveBtn, padding: "12px 28px", marginTop: 16 }}
                onClick={() => bulkSetWeekends(bulkStatus)} disabled={saving}>
                {saving ? "Applying…" : `Set all weekends to "${STATUS[bulkStatus].label}"`}
              </button>

              <h2 style={{ ...S.monthLabel, marginTop: 36 }}>Individual Weekends</h2>
              <p style={S.setupDesc}>Or switch to the Calendar tab and click any weekend to edit it directly.</p>
            </div>
          )}
        </>
      )}

      {/* ── ADMIN LOGIN BAR ── */}
      {!isAdmin && (
        <div style={S.adminArea}>
          <span style={S.adminHint}>Host access</span>
          <input style={S.pinInput} type="password" value={adminInput}
            onChange={(e) => setAdminInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && tryAdmin()}
            placeholder="PIN" maxLength={8} />
          <button className="status-btn" style={S.pinBtn} onClick={tryAdmin}>→</button>
          {adminError && <span style={{ color: "#c0392b", fontSize: 12, fontFamily: "'Lato',sans-serif" }}>Wrong PIN</span>}
        </div>
      )}

      {/* ── REQUEST MODAL ── */}
      {requestModal && (
        <div style={S.modalOverlay} onClick={(e) => e.target === e.currentTarget && setRequestModal(null)}>
          <div style={S.modal}>
            {!reqSent ? (
              <>
                <h2 style={S.modalTitle}>Request this weekend</h2>
                <p style={S.modalWeekend}>{requestModal.label}</p>
                <label style={S.modalLabel}>Your name *</label>
                <input style={S.modalInput} value={reqName}
                  onChange={(e) => setReqName(e.target.value)}
                  placeholder="e.g. Sarah & Mike" autoFocus />
                <label style={S.modalLabel}>Message (optional)</label>
                <input style={S.modalInput} value={reqNote}
                  onChange={(e) => setReqNote(e.target.value)}
                  placeholder="e.g. Just the two of us, arriving Friday night…" />
                <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                  <button className="status-btn" style={S.saveBtn}
                    onClick={submitRequest} disabled={saving || !reqName.trim()}>
                    {saving ? "Sending…" : "Send Request"}
                  </button>
                  <button className="status-btn" style={S.cancelBtn} onClick={() => setRequestModal(null)}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <div style={{ textAlign: "center", padding: "8px 0" }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>🏡</div>
                <h2 style={S.modalTitle}>Request sent!</h2>
                <p style={{ color: "#c9a96e", fontFamily: "'Lato',sans-serif", fontSize: 14, marginTop: 8 }}>
                  Patrick will confirm your stay soon.
                </p>
                <button className="status-btn" style={{ ...S.saveBtn, marginTop: 20 }}
                  onClick={() => setRequestModal(null)}>
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div style={S.footer}>Made with ♥ for friends — Putnam Valley, NY</div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Lato:wght@300;400;700&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }

  .weekend-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 13px 18px; border-radius: 10px; margin-bottom: 8px;
    border: 1.5px solid transparent;
    transition: transform 0.15s, box-shadow 0.15s;
  }
  .weekend-row.clickable { cursor: pointer; }
  .weekend-row.clickable:hover { transform: translateX(4px); box-shadow: 0 4px 18px rgba(0,0,0,0.15); }
  .weekend-row.admin-clickable { cursor: pointer; }
  .weekend-row.admin-clickable:hover { opacity: 0.88; }

  .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }

  .tab {
    background: none; border: none; border-bottom: 2px solid transparent;
    color: rgba(201,169,110,0.5); font-family: 'Lato', sans-serif;
    font-size: 13px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    padding: 10px 16px; cursor: pointer; transition: color 0.2s, border-color 0.2s;
    display: flex; align-items: center; gap: 6px;
  }
  .tab:hover { color: #c9a96e; }
  .tab.active { color: #e8c87a; border-bottom-color: #b8860b; }

  .status-btn {
    padding: 7px 14px; border-radius: 8px; border: none; cursor: pointer;
    font-family: 'Lato', sans-serif; font-size: 13px; font-weight: 700;
    letter-spacing: 0.03em; transition: opacity 0.15s, transform 0.1s;
  }
  .status-btn:hover:not(:disabled) { opacity: 0.85; transform: scale(0.97); }
  .status-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  input::placeholder { color: rgba(201,169,110,0.35); }
  input:focus { outline: none; border-color: rgba(184,134,11,0.5) !important; }
`;

const S = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(160deg,#1a120b 0%,#2c1a0e 50%,#1a120b 100%)",
    paddingBottom: 60,
    fontFamily: "'Lato',sans-serif",
  },
  toast: {
    position: "fixed", top: 20, left: "50%", transform: "translateX(-50%)",
    padding: "10px 24px", borderRadius: 30, color: "#fff",
    fontFamily: "'Lato',sans-serif", fontSize: 14, fontWeight: 700,
    zIndex: 1000, boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
    whiteSpace: "nowrap",
  },
  header: {
    textAlign: "center", padding: "48px 24px 28px",
  },
  treeLine: { fontSize: 22, marginBottom: 12, letterSpacing: 6 },
  title: {
    fontFamily: "'Playfair Display',serif",
    fontSize: "clamp(22px,5vw,38px)", color: "#f0d9a8",
    fontWeight: 700, letterSpacing: "0.01em", lineHeight: 1.2,
  },
  subtitle: {
    fontFamily: "'Playfair Display',serif", fontStyle: "italic",
    fontSize: 15, color: "#c9a96e", marginTop: 8,
  },
  tabs: {
    display: "flex", maxWidth: 580, margin: "0 auto 8px",
    padding: "0 16px", borderBottom: "1px solid rgba(201,169,110,0.15)",
  },
  badge: {
    background: "#c0392b", color: "#fff", borderRadius: 10,
    padding: "1px 6px", fontSize: 11, fontWeight: 700,
  },
  calendar: { maxWidth: 580, margin: "0 auto", padding: "0 16px" },
  monthBlock: { marginBottom: 32 },
  monthLabel: {
    fontFamily: "'Playfair Display',serif", color: "#e8c87a",
    fontSize: 19, fontWeight: 700, marginBottom: 12,
    borderBottom: "1px solid rgba(201,169,110,0.2)", paddingBottom: 8,
  },
  weekendLabel: {
    fontFamily: "'Lato',sans-serif", fontWeight: 700, fontSize: 15, color: "#2d1e0f",
  },
  weekendNote: {
    fontFamily: "'Lato',sans-serif", fontSize: 12, color: "#7a5c1e",
    fontStyle: "italic", marginTop: 2,
  },
  statusPill: {
    fontFamily: "'Lato',sans-serif", fontSize: 12, fontWeight: 700,
    letterSpacing: "0.06em", textTransform: "uppercase",
  },
  requestCta: {
    fontFamily: "'Lato',sans-serif", fontSize: 12, color: "#4a7c59",
    fontWeight: 700, letterSpacing: "0.03em",
  },
  editPanel: {
    background: "rgba(255,255,255,0.05)", border: "1.5px solid rgba(184,134,11,0.3)",
    borderRadius: 12, padding: "16px 18px", marginBottom: 10, marginTop: -4,
  },
  editTitle: {
    fontFamily: "'Playfair Display',serif", color: "#f0d9a8", fontSize: 15, marginBottom: 12,
  },
  noteInput: {
    width: "100%", background: "rgba(255,255,255,0.07)",
    border: "1px solid rgba(201,169,110,0.25)", borderRadius: 8,
    padding: "9px 12px", color: "#f0d9a8", fontSize: 13,
  },
  saveBtn:   { background: "#4a7c59", color: "#fff", border: "none" },
  cancelBtn: { background: "rgba(255,255,255,0.08)", color: "#c9a96e", border: "1px solid rgba(201,169,110,0.3)" },
  approveBtn: { background: "#4a7c59", color: "#fff", border: "none" },
  declineBtn: { background: "rgba(255,255,255,0.08)", color: "#c0392b", border: "1px solid #c0392b" },
  requestCard: {
    background: "rgba(255,255,255,0.05)", border: "1px solid rgba(201,169,110,0.2)",
    borderRadius: 12, padding: "14px 18px", marginBottom: 10,
  },
  reqTop: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  reqName: { fontFamily: "'Lato',sans-serif", fontWeight: 700, fontSize: 15, color: "#f0d9a8" },
  reqWeekend: { fontFamily: "'Lato',sans-serif", fontSize: 13, color: "#c9a96e", marginTop: 2 },
  reqUserNote: { fontFamily: "'Lato',sans-serif", fontSize: 12, color: "#7a5c1e", fontStyle: "italic", marginTop: 4 },
  reqDate: { fontFamily: "'Lato',sans-serif", fontSize: 11, color: "rgba(201,169,110,0.4)", marginTop: 8 },
  setupDesc: {
    fontFamily: "'Lato',sans-serif", fontSize: 13, color: "rgba(201,169,110,0.6)",
    marginBottom: 16, lineHeight: 1.6,
  },
  bulkRow: { display: "flex", gap: 10, flexWrap: "wrap" },
  adminArea: {
    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
    marginTop: 40, padding: "0 16px",
  },
  adminHint: { color: "rgba(201,169,110,0.4)", fontSize: 13 },
  pinInput: {
    width: 80, background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(201,169,110,0.2)", borderRadius: 8,
    padding: "7px 10px", color: "#f0d9a8", fontSize: 14, textAlign: "center",
  },
  pinBtn: { background: "rgba(201,169,110,0.12)", color: "#c9a96e", border: "1px solid rgba(201,169,110,0.3)" },
  loading: {
    textAlign: "center", color: "#c9a96e", fontFamily: "'Playfair Display',serif",
    fontStyle: "italic", padding: 60, fontSize: 16,
  },
  empty: {
    color: "rgba(201,169,110,0.5)", fontFamily: "'Lato',sans-serif",
    fontStyle: "italic", fontSize: 14, padding: "20px 0",
  },
  modalOverlay: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
    display: "flex", alignItems: "center", justifyContent: "center",
    zIndex: 500, padding: 16,
  },
  modal: {
    background: "#2c1a0e", border: "1.5px solid rgba(184,134,11,0.4)",
    borderRadius: 16, padding: "28px 24px", maxWidth: 420, width: "100%",
    boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
  },
  modalTitle: {
    fontFamily: "'Playfair Display',serif", color: "#f0d9a8",
    fontSize: 22, fontWeight: 700, marginBottom: 4,
  },
  modalWeekend: {
    fontFamily: "'Lato',sans-serif", color: "#c9a96e", fontSize: 14, marginBottom: 20,
  },
  modalLabel: {
    fontFamily: "'Lato',sans-serif", color: "rgba(201,169,110,0.7)",
    fontSize: 12, fontWeight: 700, letterSpacing: "0.05em",
    textTransform: "uppercase", display: "block", marginBottom: 6,
  },
  modalInput: {
    width: "100%", background: "rgba(255,255,255,0.07)",
    border: "1px solid rgba(201,169,110,0.25)", borderRadius: 8,
    padding: "10px 12px", color: "#f0d9a8", fontSize: 14, marginBottom: 14,
  },
  footer: {
    textAlign: "center", marginTop: 52,
    fontFamily: "'Playfair Display',serif", fontStyle: "italic",
    color: "rgba(201,169,110,0.3)", fontSize: 13,
  },
};
