-- =============================================================================
-- 031 — Attendance corrections are stored in UTC
--
-- Every DATETIME in the HR module is UTC: the pool pins its session to UTC and
-- the driver reads DATETIME as UTC. Regularisations were the exception. The
-- requested times were written as the company's wall clock ("09:00" on the
-- work date), so they read back as 09:00Z, which the app showed as 14:30, and
-- an approval wrote a session five and a half hours late. Durations were right,
-- which is why the hours looked correct while the times did not.
--
-- The service now converts on the way in. This converts the rows written by
-- the old code, which is every row that exists when this migration runs: the
-- fix and this file ship together.
--
-- The offset is fixed rather than named, for the reason in attendance.schema:
-- CONVERT_TZ with a zone NAME returns NULL unless the server's timezone tables
-- are loaded.
-- =============================================================================

UPDATE hr_regularisations
   SET requested_check_in_at  = CONVERT_TZ(requested_check_in_at,  '+05:30', '+00:00'),
       requested_check_out_at = CONVERT_TZ(requested_check_out_at, '+05:30', '+00:00');

-- The sessions an approval wrote from those times, and only those.
UPDATE hr_attendance_sessions
   SET started_at = CONVERT_TZ(started_at, '+05:30', '+00:00'),
       ended_at   = CONVERT_TZ(ended_at,   '+05:30', '+00:00')
 WHERE source = 'regularisation';

-- Re-derive first-in and last-out for the days those sessions belong to. The
-- totals (worked and break minutes) are unchanged by a shift of both ends.
UPDATE hr_attendance a
   SET a.checked_in_at = (
         SELECT MIN(s.started_at) FROM hr_attendance_sessions s WHERE s.attendance_id = a.id),
       a.checked_out_at = (
         SELECT CASE WHEN COUNT(CASE WHEN s.ended_at IS NULL THEN 1 END) > 0
                     THEN NULL ELSE MAX(s.ended_at) END
           FROM hr_attendance_sessions s WHERE s.attendance_id = a.id)
 WHERE EXISTS (
   SELECT 1 FROM hr_attendance_sessions s
    WHERE s.attendance_id = a.id AND s.source = 'regularisation');
