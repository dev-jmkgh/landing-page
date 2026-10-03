-- Adds a baseline `employee` role, for staff who are not telecallers.
--
-- WHY A NEW ROLE RATHER THAN REUSING `telecaller`
-- -----------------------------------------------
-- The HR mobile app lets staff register themselves, and until now self-registration had
-- exactly one outcome: `role = 'telecaller'`. That is correct for the telecalling app and
-- wrong for everybody else — an accountant who signs up would be created as a telecaller
-- and, once approved, would appear in the lead-assignment picker on the admin portal,
-- because `listAssignableEmployees` filters on active-and-approved and nothing else.
-- Somebody would then assign a customer to a person with no telephone script and no
-- reason to be holding a lead.
--
-- WHY IT IS APPENDED AND WHY THE RANK IS ZERO
-- -------------------------------------------
-- MySQL stores ENUM values as indexes, so appending a value leaves every existing row
-- untouched; inserting one in the middle would silently renumber them. The value goes
-- last for that reason, not for tidiness.
--
-- In `actor.ts` it ranks 0, BELOW telecaller's 1. That ordering is what makes this
-- change additive: `hasRole(actor, 'telecaller')` and every gate above it already read a
-- numeric rank, so an employee is refused by all of them without a single call site
-- changing. No existing row has this role, so nothing an administrator sees today moves.
--
-- NOT A PERMISSION FOR HR FEATURES
-- --------------------------------
-- This says what someone is NOT — not a telecaller. It is deliberately not an "HR access"
-- grant: when payroll and salary land, who may read them is a separate decision that
-- needs its own role above this one, and reusing this value for it would hand every
-- self-registered employee the keys.
ALTER TABLE telecaller_users
  MODIFY COLUMN role
    ENUM('admin','manager','supervisor','telecaller','employee')
    NOT NULL DEFAULT 'telecaller';
