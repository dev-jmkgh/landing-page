-- =============================================================================
-- 035 — Paying an employee in full, by an administrator's decision
--
-- Payroll no longer pays days nobody can account for. Days before attendance tracking
-- began (the HR setting `attendance_tracked_from`) were paid in full without judging;
-- they now count like any other working day: no attendance, no leave → absent → loss of
-- pay. HR asked for the reverse default — deduct, unless an administrator chooses to pay.
--
-- That choice is recorded here, per pay period and employee, with the reason. It lives in
-- its own table rather than on the payslip because payslips are rebuilt on every
-- calculation; the decision has to survive them. While it stands, the employee's loss of
-- pay in that period is waived (the absences still show), and the payslip carries how
-- many days were waived and why.
-- =============================================================================

CREATE TABLE IF NOT EXISTS hr_payroll_full_pay (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id       BIGINT UNSIGNED NOT NULL,
  user_id      BIGINT UNSIGNED NOT NULL,
  reason       VARCHAR(500)    NOT NULL,
  -- The admin-portal account that decided. Not a foreign key: admin accounts live in the
  -- telecalling user table, which the HR module never joins (see hr_attendance.flag_reviewed_by).
  set_by       BIGINT UNSIGNED NULL,
  set_by_name  VARCHAR(160)    NULL,
  created_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_hr_payroll_full_pay_run_user (run_id, user_id),
  CONSTRAINT fk_hr_payroll_full_pay_run
    FOREIGN KEY (run_id) REFERENCES hr_payroll_runs (id) ON DELETE CASCADE,
  CONSTRAINT fk_hr_payroll_full_pay_user
    FOREIGN KEY (user_id) REFERENCES hr_users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

ALTER TABLE hr_payslips
  ADD COLUMN lop_waived_days DECIMAL(5,1) NOT NULL DEFAULT 0 AFTER lop_days,
  ADD COLUMN full_pay_reason VARCHAR(500) NULL AFTER lop_waived_days;
