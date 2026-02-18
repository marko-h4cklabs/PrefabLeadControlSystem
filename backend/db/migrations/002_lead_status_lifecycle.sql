-- Lead status lifecycle: new | contacted | qualified | booked | closed_won | closed_lost
-- Map legacy values to new lifecycle, then add constraint

UPDATE leads SET status = 'qualified' WHERE status IN ('hot', 'warm');
UPDATE leads SET status = 'closed_lost' WHERE status IN ('cold', 'lost');
UPDATE leads SET status = 'closed_won' WHERE status = 'converted';
UPDATE leads SET status = 'new' WHERE status IS NULL OR status NOT IN ('new', 'contacted', 'qualified', 'booked', 'closed_won', 'closed_lost');

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_status_check
  CHECK (status IN ('new', 'contacted', 'qualified', 'booked', 'closed_won', 'closed_lost'));
