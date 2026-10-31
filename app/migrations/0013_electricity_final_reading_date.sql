ALTER TABLE electricity_bills ADD COLUMN final_reading_date TEXT;
UPDATE electricity_bills SET final_reading_date = substr(updated_at,1,10) WHERE final_reading_date IS NULL;
