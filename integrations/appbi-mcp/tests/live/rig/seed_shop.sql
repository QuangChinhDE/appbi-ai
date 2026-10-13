-- Deterministic source data for the MCP acceptance rig (database: shopsrc).
-- Every KPI the tests assert is recomputed independently from these tables.
CREATE SCHEMA IF NOT EXISTS shop;
DROP TABLE IF EXISTS shop.orders, shop.customers, shop.products, shop.customer_regions_dup;

CREATE TABLE shop.customers (
  customer_id   integer PRIMARY KEY,
  customer_name text NOT NULL,
  region        text NOT NULL,
  segment       text NOT NULL
);
INSERT INTO shop.customers
SELECT i,
       'Customer ' || lpad(i::text, 3, '0'),
       (ARRAY['North','South','East','West'])[1 + (i % 4)],
       (ARRAY['Consumer','Corporate','SMB'])[1 + (i % 3)]
FROM generate_series(1, 200) AS i;

CREATE TABLE shop.products (
  product_id   integer PRIMARY KEY,
  product_name text NOT NULL,
  category     text NOT NULL,
  unit_price   numeric(12,2) NOT NULL
);
INSERT INTO shop.products
SELECT i,
       'Product ' || lpad(i::text, 2, '0'),
       (ARRAY['Furniture','Office','Tech','Garden','Kitchen'])[1 + (i % 5)],
       (10 + (i * 37) % 490)::numeric(12,2)
FROM generate_series(1, 50) AS i;

CREATE TABLE shop.orders (
  order_id    integer PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES shop.customers(customer_id),
  product_id  integer NOT NULL REFERENCES shop.products(product_id),
  order_date  date NOT NULL,
  quantity    integer NOT NULL,
  amount      numeric(12,2) NOT NULL,
  status      text NOT NULL
);
INSERT INTO shop.orders
SELECT g.i,
       1 + ((g.i * 7) % 200),
       p.product_id,
       DATE '2026-01-01' + (g.i % 270),
       1 + (g.i % 5),
       ((1 + (g.i % 5)) * p.unit_price)::numeric(12,2),
       CASE WHEN g.i % 10 = 0 THEN 'cancelled' ELSE 'completed' END
FROM generate_series(1, 3000) AS g(i)
JOIN shop.products p ON p.product_id = 1 + ((g.i * 13) % 50);

-- Fan-out trap: customer_id is NOT unique here (customers divisible by 5 appear twice).
CREATE TABLE shop.customer_regions_dup (
  customer_id integer NOT NULL,
  region      text NOT NULL
);
INSERT INTO shop.customer_regions_dup SELECT customer_id, region FROM shop.customers;
INSERT INTO shop.customer_regions_dup SELECT customer_id, 'Duplicate' FROM shop.customers WHERE customer_id % 5 = 0;

ANALYZE shop.customers; ANALYZE shop.products; ANALYZE shop.orders; ANALYZE shop.customer_regions_dup;

-- A dimension with NO foreign key: the MCP itself must create this relationship.
DROP TABLE IF EXISTS shop.segments;
CREATE TABLE shop.segments (segment text NOT NULL, segment_owner text NOT NULL, target numeric(12,2) NOT NULL);
INSERT INTO shop.segments VALUES ('Consumer','Alice',800000),('Corporate','Bao',700000),('SMB','Chi',600000);
ANALYZE shop.segments;
