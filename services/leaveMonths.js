/* The monthly leave cap, month by month (17 Oct 2026).
   A leave is split into the months it touches; each month gives its own room,
   min(the leave's days in that month, cap − days already away that month).
   Pure: leaveRoutes.js reads the usage and hands it in. */

function inclusiveDays(from, to) {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000) + 1;
}

/** [{ key: "YYYY-MM", from, to, days }] for each month a leave touches. */
function monthSegments(fromDate, toDate, isHalfDay, countDays = inclusiveDays) {
  if (!fromDate) return [];
  const end = toDate || fromDate;
  if (isHalfDay) return [{ key: fromDate.slice(0, 7), from: fromDate, to: fromDate, days: 0.5 }];
  const out = [];
  let [y, m] = fromDate.split("-").map(Number);
  for (let guard = 0; guard < 24; guard += 1) {
    const mm = String(m).padStart(2, "0");
    const ms = `${y}-${mm}-01`;
    const me = `${y}-${mm}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
    if (ms > end) break;
    const from = fromDate > ms ? fromDate : ms;
    const to = end < me ? end : me;
    if (from <= to) out.push({ key: `${y}-${mm}`, from, to, days: countDays(from, to) });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** The paid room the monthly cap leaves, given each month's days already away.
    `more` adds further caps checked in the SAME month (the CL cap of 3 beside the
    days-away cap): [{ cap, used: [per month] }]. */
function roomFromMonths(segments, usedByMonth, cap, more = []) {
  let room = 0;
  const months = segments.map((sg, i) => {
    const used = Number(usedByMonth[i]) || 0;
    let left = Math.max(0, cap - used);
    for (const c of more) left = Math.min(left, Math.max(0, c.cap - (Number(c.used?.[i]) || 0)));
    room += Math.min(sg.days, left);
    return { month: sg.key, days: sg.days, used, left };
  });
  return { room, months };
}

module.exports = { monthSegments, roomFromMonths, inclusiveDays };
