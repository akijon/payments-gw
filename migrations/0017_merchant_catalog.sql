-- migrations/0017_merchant_catalog.sql
-- Replace development catalog fixtures with the approved merchant catalog
-- (irja-storefront-2026 app/data/products.ts AuthoredProduct[], as supplied
-- by the release owner). Retires DEPLOYMENT_GATE.md's dev-fixture blocker.
--
-- Deactivates rather than deletes the old dev SKUs: any historical order,
-- payment_event, or invoice row still references them by id, and products
-- has no ON DELETE behavior defined for those foreign keys.
UPDATE products SET active = 0
WHERE id IN (
  'HOODIE-BLK-M', 'TSHIRT-WHT-L', 'JEANS-BLUE-32',
  'LOPAPEYSA-M', 'LOPAPEYSA-L', 'WOOL-SCARF', 'WOOL-HAT'
);

-- Prices are whole ISK krónur (major units) per the settled convention in
-- DEPLOYMENT_GATE.md. All items are standard-rate VAT (24%).
INSERT OR IGNORE INTO products (id, name, description, unit_price, currency, vat_rate, active) VALUES
    ('meross-radiator-valve',      'Meross - Snjall ofnloki',                        'Stýrðu hitanum með appi, rödd eða rútínum og sparaðu orku þegar enginn er heima.',                                          8900,  'ISK', 24, 1),
    ('eve-thermo-four-pack',       'Eve Thermo - Snjall ofnloki (efni) 4 stk.',      'Matter-studd hitastýring fyrir allt heimilið - einföld, örugg og orkusparandi.',                                            55000, 'ISK', 24, 1),
    ('tado-radiator-thermostat-x', 'Tado° snjallhitastillir fyrir ofn X',            'Nákvæm, einstaklingsmiðuð hitastýring sem virkar með helstu snjallheimiliskerfum.',                                         14500, 'ISK', 24, 1),
    ('eve-thermo-single',          'Eve Thermo - Snjall ofnloki (einn)',             'Matter-studdur snjall ofnloki fyrir einn radiator - nákvæm, örugg og orkusparandi hitastýring.',                            12990, 'ISK', 24, 1),
    ('meross-led-strip-pro-5m',    'Meross LED Strip Pro 5 m',                       'Snjallt ljósband með RGB og hvítu ljósi, Matter-samhæft. Virkar með HomeKit, Alexa og Google Home.',                        12990, 'ISK', 24, 1),
    ('sonoff-mini-extreme-matter', 'Sonoff MINI Extreme (Matter)',                   'Snjallrofi til innfelldra rafrása (in-wall relay) með Matter-stuðningi. Virkar með HomeKit, Alexa og Google Home.',         3900,  'ISK', 24, 1);
