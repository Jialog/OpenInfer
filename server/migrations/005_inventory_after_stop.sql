-- A device is selectable again only with an inventory probed after the end of its instances:
-- a stopped instance keeps the sequence of the first inventory the
-- device probed after its end, in the boot that reported it; an inventory carries its own sequence (its probe's order).
BEGIN;
ALTER TABLE instances ADD COLUMN inventory_after bigint CHECK (inventory_after > 0);
ALTER TABLE instances ADD COLUMN inventory_after_boot uuid;
ALTER TABLE instances ADD CONSTRAINT instances_inventory_after_boot CHECK ((inventory_after IS NULL) = (inventory_after_boot IS NULL));
COMMIT;
