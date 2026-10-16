-- =============================================================================
-- 030 — Payroll: salary structures, payroll runs and payslips
--
-- THE SHAPE OF IT
--
--   salary structure  what someone is paid per month, as earning and deduction
--                     lines, effective from a date. A raise is a NEW structure
--                     with a later date, never an edit to the old one — last
--                     March's payslip must still recompute to what was paid.
--   payroll run       one calendar month. draft -> processed -> approved.
--                     Processing computes a payslip per employee and may be
--                     repeated while the run is not approved. Approval freezes
--                     it and is the moment employees can see their payslips.
--   payslip           the frozen result for one person in one run, with the
--                     attendance arithmetic that produced it and its lines.
--
-- MONEY IS DECIMAL(12,2), computed in integer paise by the service. A float
-- cannot hold 0.10, and payroll is the one place a stray paisa is a dispute.
--
-- WHO CAN SEE IT: payroll is read and written by administrators only. The
-- employee reads their own payslips of APPROVED runs through the HR app, and
-- nothing else here. A draft payslip is not visible to anyone in the app.
-- =============================================================================

CREATE TABLE IF NOT EXISTS hr_salary_structures (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  effective_from  DATE            NOT NULL,
  note            VARCHAR(255)    NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_by_name VARCHAR(120)    NULL,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- One structure per person per start date. The structure in force on a day
  -- is the one with the latest effective_from on or before it.
  UNIQUE KEY uq_hr_salary_structures (user_id, effective_from),
  CONSTRAINT fk_hr_salary_structures_user
    FOREIGN KEY (user_id) REFERENCES hr_users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hr_salary_components (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  structure_id  BIGINT UNSIGNED NOT NULL,
  label         VARCHAR(80)     NOT NULL,
  kind          ENUM('earning','deduction') NOT NULL,
  -- The full monthly amount, before any loss of pay.
  amount        DECIMAL(12,2)   NOT NULL,
  -- Earnings only: reduced in proportion to loss-of-pay days. A fixed
  -- reimbursement is not. Ignored for deductions, which are fixed amounts.
  prorated      TINYINT(1)      NOT NULL DEFAULT 1,
  sort_order    SMALLINT        NOT NULL DEFAULT 0,

  PRIMARY KEY (id),
  KEY idx_hr_salary_components_structure (structure_id, sort_order),
  CONSTRAINT fk_hr_salary_components_structure
    FOREIGN KEY (structure_id) REFERENCES hr_salary_structures (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hr_payroll_runs (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- 'YYYY-MM'. One run per month.
  period            CHAR(7)         NOT NULL,
  period_start      DATE            NOT NULL,
  period_end        DATE            NOT NULL,
  status            ENUM('draft','processed','approved') NOT NULL DEFAULT 'draft',

  -- Totals rolled up when the run is processed.
  employee_count    INT UNSIGNED    NOT NULL DEFAULT 0,
  total_gross       DECIMAL(14,2)   NOT NULL DEFAULT 0,
  total_deductions  DECIMAL(14,2)   NOT NULL DEFAULT 0,
  total_net         DECIMAL(14,2)   NOT NULL DEFAULT 0,

  note              VARCHAR(500)    NULL,
  created_by        BIGINT UNSIGNED NULL,
  processed_by      BIGINT UNSIGNED NULL,
  processed_at      DATETIME        NULL,
  approved_by       BIGINT UNSIGNED NULL,
  approved_by_name  VARCHAR(120)    NULL,
  approved_at       DATETIME        NULL,
  created_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_hr_payroll_runs_period (period),
  KEY idx_hr_payroll_runs_status (status, period)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hr_payslips (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id             BIGINT UNSIGNED NOT NULL,
  user_id            BIGINT UNSIGNED NOT NULL,
  structure_id       BIGINT UNSIGNED NULL,

  -- Snapshots of the employee as they were when the run was processed. A
  -- payslip is a document: renaming a department must not rewrite last year's.
  employee_code      VARCHAR(24)     NOT NULL,
  employee_name      VARCHAR(120)    NOT NULL,
  department_name    VARCHAR(120)    NULL,
  designation_name   VARCHAR(120)    NULL,

  -- The attendance arithmetic, in days. Halves are real (a half-day leave).
  days_in_period     SMALLINT UNSIGNED NOT NULL,
  -- Days in the period before joining or after exit: not payable at all.
  unemployed_days    DECIMAL(5,1)    NOT NULL DEFAULT 0,
  weekly_off_days    DECIMAL(5,1)    NOT NULL DEFAULT 0,
  holiday_days       DECIMAL(5,1)    NOT NULL DEFAULT 0,
  present_days       DECIMAL(5,1)    NOT NULL DEFAULT 0,
  paid_leave_days    DECIMAL(5,1)    NOT NULL DEFAULT 0,
  unpaid_leave_days  DECIMAL(5,1)    NOT NULL DEFAULT 0,
  absent_days        DECIMAL(5,1)    NOT NULL DEFAULT 0,
  -- Days before attendance tracking began (HR setting), paid without judging.
  untracked_days     DECIMAL(5,1)    NOT NULL DEFAULT 0,
  lop_days           DECIMAL(5,1)    NOT NULL DEFAULT 0,
  paid_days          DECIMAL(5,1)    NOT NULL DEFAULT 0,

  gross_earnings     DECIMAL(12,2)   NOT NULL DEFAULT 0,
  lop_amount         DECIMAL(12,2)   NOT NULL DEFAULT 0,
  total_deductions   DECIMAL(12,2)   NOT NULL DEFAULT 0,
  net_pay            DECIMAL(12,2)   NOT NULL DEFAULT 0,

  created_at         TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_hr_payslips_run_user (run_id, user_id),
  KEY idx_hr_payslips_user (user_id, run_id),
  CONSTRAINT fk_hr_payslips_run
    FOREIGN KEY (run_id) REFERENCES hr_payroll_runs (id) ON DELETE CASCADE,
  CONSTRAINT fk_hr_payslips_user
    FOREIGN KEY (user_id) REFERENCES hr_users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hr_payslip_lines (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  payslip_id   BIGINT UNSIGNED NOT NULL,
  label        VARCHAR(80)     NOT NULL,
  kind         ENUM('earning','deduction') NOT NULL,
  -- What the line is worth for a full month, and what was actually paid.
  full_amount  DECIMAL(12,2)   NOT NULL,
  amount       DECIMAL(12,2)   NOT NULL,
  sort_order   SMALLINT        NOT NULL DEFAULT 0,

  PRIMARY KEY (id),
  KEY idx_hr_payslip_lines_payslip (payslip_id, sort_order),
  CONSTRAINT fk_hr_payslip_lines_payslip
    FOREIGN KEY (payslip_id) REFERENCES hr_payslips (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
