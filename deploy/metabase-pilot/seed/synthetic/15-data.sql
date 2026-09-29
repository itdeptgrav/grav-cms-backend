-- 15-data.sql — the synthetic dataset.
--
-- EVERY NAME HERE IS INVENTED. The companies are "(Sample)", the parties are
-- named after weather and minerals, every email is `.invalid` (RFC 2606, a TLD
-- guaranteed never to resolve) and every GSTIN/PAN uses the AAAAA0000A filler
-- pattern. If a name in this file ever looks like a real GRAV customer,
-- something has gone wrong and 90-validate.sql is meant to catch it.
--
-- Transactions are GENERATED rather than typed, because a hand-written ledger
-- drifts out of balance the moment someone edits one number. Each voucher is
-- built from a template whose debits and credits are constructed to sum to
-- zero, and 90-validate.sql refuses the whole seed if any of them does not.

SET search_path TO accounting;

INSERT INTO companies (company_id, company_name, gstin, state_code, books_from_date) VALUES
  ('c-nimbus', 'Nimbus Handlooms (Sample) Pvt Ltd', '27AAAAA0000A1Z5', '27', DATE '2025-04-01'),
  ('c-quartz', 'Quartz Apparel (Sample) LLP',       '29AAAAA0000B1Z4', '29', DATE '2025-04-01');

-- Groups and ledgers, mirrored for both companies so every report can be run
-- per company and compared.
INSERT INTO account_groups (group_id, company_id, group_name, nature)
SELECT c.company_id || g.suffix, c.company_id, g.group_name, g.nature
FROM companies c
CROSS JOIN (VALUES
  ('-g-debtors',   'Sundry Debtors',      'asset'),
  ('-g-creditors', 'Sundry Creditors',    'liability'),
  ('-g-bank',      'Bank Accounts',       'asset'),
  ('-g-cash',      'Cash-in-Hand',        'asset'),
  ('-g-sales',     'Sales Accounts',      'income'),
  ('-g-purchase',  'Purchase Accounts',   'expense'),
  ('-g-expense',   'Indirect Expenses',   'expense'),
  ('-g-duties',    'Duties & Taxes',      'liability')
) AS g(suffix, group_name, nature);

INSERT INTO ledgers (ledger_id, company_id, group_id, ledger_name, nature)
SELECT c.company_id || l.suffix, c.company_id, c.company_id || l.group_suffix, l.ledger_name, l.nature
FROM companies c
CROSS JOIN (VALUES
  ('-l-bank',        '-g-bank',      'Bank — Current Account', 'asset'),
  ('-l-cash',        '-g-cash',      'Cash',                   'asset'),
  ('-l-sales',       '-g-sales',     'Sales — Local',          'income'),
  ('-l-purchase',    '-g-purchase',  'Purchases — Local',      'expense'),
  ('-l-rent',        '-g-expense',   'Rent',                   'expense'),
  ('-l-freight',     '-g-expense',   'Freight & Carriage',     'expense'),
  ('-l-accrual',     '-g-creditors', 'Accrued Expenses',       'liability'),
  ('-l-cgst-out',    '-g-duties',    'CGST Payable',           'liability'),
  ('-l-sgst-out',    '-g-duties',    'SGST Payable',           'liability'),
  ('-l-cgst-in',     '-g-duties',    'CGST Input Credit',      'asset'),
  ('-l-sgst-in',     '-g-duties',    'SGST Input Credit',      'asset')
) AS l(suffix, group_suffix, ledger_name, nature);

-- Party ledgers, one per party, then the parties themselves.
INSERT INTO ledgers (ledger_id, company_id, group_id, ledger_name, nature)
SELECT c.company_id || p.suffix,
       c.company_id,
       c.company_id || (CASE WHEN p.party_type = 'customer' THEN '-g-debtors' ELSE '-g-creditors' END),
       p.party_name,
       CASE WHEN p.party_type = 'customer' THEN 'asset' ELSE 'liability' END
FROM companies c
CROSS JOIN (VALUES
  ('-p-cirrus',   'Cirrus Retail (Sample)',      'customer'),
  ('-p-stratus',  'Stratus Stores (Sample)',     'customer'),
  ('-p-cumulus',  'Cumulus Bazaar (Sample)',     'customer'),
  ('-p-basalt',   'Basalt Yarns (Sample)',       'supplier'),
  ('-p-gypsum',   'Gypsum Dyeworks (Sample)',    'supplier')
) AS p(suffix, party_name, party_type);

INSERT INTO parties (party_id, company_id, ledger_id, party_name, party_type, gstin, state, credit_days)
SELECT c.company_id || p.suffix,
       c.company_id,
       c.company_id || p.suffix,
       p.party_name,
       p.party_type,
       p.gstin,
       p.state,
       p.credit_days
FROM companies c
CROSS JOIN (VALUES
  ('-p-cirrus',  'Cirrus Retail (Sample)',   'customer', '27AAAAA1111C1Z3', 'Maharashtra', 30),
  ('-p-stratus', 'Stratus Stores (Sample)',  'customer', '29AAAAA2222D1Z2', 'Karnataka',   45),
  ('-p-cumulus', 'Cumulus Bazaar (Sample)',  'customer', '24AAAAA3333E1Z1', 'Gujarat',     15),
  ('-p-basalt',  'Basalt Yarns (Sample)',    'supplier', '27AAAAA4444F1Z0', 'Maharashtra', 30),
  ('-p-gypsum',  'Gypsum Dyeworks (Sample)', 'supplier', '29AAAAA5555G1Z9', 'Karnataka',   60)
) AS p(suffix, party_name, party_type, gstin, state, credit_days);

-- ── Transactions ───────────────────────────────────────────────────────────
DO $$
DECLARE
  comp           record;
  m              integer;
  d              date;
  seq            integer := 0;
  v_id           text;
  taxable        numeric(14,2);
  tax            numeric(14,2);
  total          numeric(14,2);
  cust           text;
  supp           text;
  customers      text[] := ARRAY['-p-cirrus','-p-stratus','-p-cumulus'];
  suppliers      text[] := ARRAY['-p-basalt','-p-gypsum'];
  gst_rate       numeric(5,2) := 18.00;

BEGIN
  FOR comp IN SELECT company_id FROM companies ORDER BY company_id LOOP
    FOR m IN 0..11 LOOP
      d := DATE '2025-04-01' + (m || ' months')::interval;

      -- ── SALES ────────────────────────────────────────────────────────────
      -- Dr Customer (total) | Cr Sales (taxable) + Cr CGST + Cr SGST
      FOR i IN 1..3 LOOP
        seq := seq + 1;
        cust := customers[1 + ((m + i) % 3)];
        taxable := 40000 + ((m * 1700 + i * 5300) % 60000);
        tax     := ROUND(taxable * gst_rate / 100, 2);
        total   := taxable + tax;
        v_id    := 'v-' || seq;

        INSERT INTO vouchers (voucher_id, company_id, voucher_number, voucher_type, voucher_date, party_id, narration, status, grand_total)
        VALUES (v_id, comp.company_id, 'SV-' || LPAD(seq::text, 5, '0'), 'sales', d + (i * 3),
                comp.company_id || cust, 'Sample sales invoice', 'posted', total);

        INSERT INTO voucher_lines (voucher_id, company_id, line_no, ledger_id, party_id, dr_cr, amount, signed_amount, gst_rate, taxable_value, tax_amount) VALUES
          (v_id, comp.company_id, 1, comp.company_id || cust,        comp.company_id || cust, 'Dr', total,   total,    NULL,     NULL,    NULL),
          (v_id, comp.company_id, 2, comp.company_id || '-l-sales',  NULL, 'Cr', taxable, -taxable, gst_rate, taxable, tax),
          (v_id, comp.company_id, 3, comp.company_id || '-l-cgst-out', NULL, 'Cr', ROUND(tax/2,2), -ROUND(tax/2,2), gst_rate/2, taxable, ROUND(tax/2,2)),
          (v_id, comp.company_id, 4, comp.company_id || '-l-sgst-out', NULL, 'Cr', tax - ROUND(tax/2,2), -(tax - ROUND(tax/2,2)), gst_rate/2, taxable, tax - ROUND(tax/2,2));
      END LOOP;

      -- ── PURCHASE ─────────────────────────────────────────────────────────
      FOR i IN 1..2 LOOP
        seq := seq + 1;
        supp := suppliers[1 + ((m + i) % 2)];
        taxable := 22000 + ((m * 900 + i * 3100) % 30000);
        tax     := ROUND(taxable * gst_rate / 100, 2);
        total   := taxable + tax;
        v_id    := 'v-' || seq;

        INSERT INTO vouchers (voucher_id, company_id, voucher_number, voucher_type, voucher_date, party_id, narration, status, grand_total)
        VALUES (v_id, comp.company_id, 'PV-' || LPAD(seq::text, 5, '0'), 'purchase', d + (i * 5),
                comp.company_id || supp, 'Sample purchase bill', 'posted', total);

        INSERT INTO voucher_lines (voucher_id, company_id, line_no, ledger_id, party_id, dr_cr, amount, signed_amount, gst_rate, taxable_value, tax_amount) VALUES
          (v_id, comp.company_id, 1, comp.company_id || '-l-purchase', NULL, 'Dr', taxable, taxable, gst_rate, taxable, tax),
          (v_id, comp.company_id, 2, comp.company_id || '-l-cgst-in',  NULL, 'Dr', ROUND(tax/2,2), ROUND(tax/2,2), gst_rate/2, taxable, ROUND(tax/2,2)),
          (v_id, comp.company_id, 3, comp.company_id || '-l-sgst-in',  NULL, 'Dr', tax - ROUND(tax/2,2), tax - ROUND(tax/2,2), gst_rate/2, taxable, tax - ROUND(tax/2,2)),
          (v_id, comp.company_id, 4, comp.company_id || supp, comp.company_id || supp, 'Cr', total, -total, NULL, NULL, NULL);
      END LOOP;

      -- ── RECEIPT ──────────────────────────────────────────────────────────
      -- Dr Bank | Cr Customer. Deliberately less than billed, so customer
      -- balances are non-zero and an outstanding report has something to show.
      seq := seq + 1;
      cust := customers[1 + (m % 3)];
      total := 35000 + ((m * 2300) % 25000);
      v_id := 'v-' || seq;
      INSERT INTO vouchers (voucher_id, company_id, voucher_number, voucher_type, voucher_date, party_id, narration, status, grand_total)
      VALUES (v_id, comp.company_id, 'RV-' || LPAD(seq::text,5,'0'), 'receipt', d + 20,
              comp.company_id || cust, 'Sample receipt against invoice', 'posted', total);
      INSERT INTO voucher_lines (voucher_id, company_id, line_no, ledger_id, party_id, dr_cr, amount, signed_amount) VALUES
        (v_id, comp.company_id, 1, comp.company_id || '-l-bank', NULL, 'Dr', total,  total),
        (v_id, comp.company_id, 2, comp.company_id || cust, comp.company_id || cust, 'Cr', total, -total);
      INSERT INTO bank_transactions (bank_txn_id, company_id, ledger_id, txn_date, narration, direction, amount, voucher_id, is_reconciled)
      VALUES ('bt-' || seq, comp.company_id, comp.company_id || '-l-bank', d + 20, 'Customer receipt (sample)', 'inflow', total, v_id, (m % 3 <> 0));

      -- ── PAYMENT ──────────────────────────────────────────────────────────
      seq := seq + 1;
      supp := suppliers[1 + (m % 2)];
      total := 18000 + ((m * 1300) % 14000);
      v_id := 'v-' || seq;
      INSERT INTO vouchers (voucher_id, company_id, voucher_number, voucher_type, voucher_date, party_id, narration, status, grand_total)
      VALUES (v_id, comp.company_id, 'PY-' || LPAD(seq::text,5,'0'), 'payment', d + 24,
              comp.company_id || supp, 'Sample supplier payment', 'posted', total);
      INSERT INTO voucher_lines (voucher_id, company_id, line_no, ledger_id, party_id, dr_cr, amount, signed_amount) VALUES
        (v_id, comp.company_id, 1, comp.company_id || supp, comp.company_id || supp, 'Dr', total, total),
        (v_id, comp.company_id, 2, comp.company_id || '-l-bank', NULL, 'Cr', total, -total);
      INSERT INTO bank_transactions (bank_txn_id, company_id, ledger_id, txn_date, narration, direction, amount, voucher_id, is_reconciled)
      VALUES ('bt-p-' || seq, comp.company_id, comp.company_id || '-l-bank', d + 24, 'Supplier payment (sample)', 'outflow', total, v_id, (m % 4 <> 0));

      -- ── JOURNAL ──────────────────────────────────────────────────────────
      -- Dr Rent | Cr Accrued Expenses.
      seq := seq + 1;
      total := 12000;
      v_id := 'v-' || seq;
      INSERT INTO vouchers (voucher_id, company_id, voucher_number, voucher_type, voucher_date, narration, status, grand_total)
      VALUES (v_id, comp.company_id, 'JV-' || LPAD(seq::text,5,'0'), 'journal', d + 27, 'Monthly rent accrual (sample)', 'posted', total);
      INSERT INTO voucher_lines (voucher_id, company_id, line_no, ledger_id, dr_cr, amount, signed_amount) VALUES
        (v_id, comp.company_id, 1, comp.company_id || '-l-rent',    'Dr', total,  total),
        (v_id, comp.company_id, 2, comp.company_id || '-l-accrual', 'Cr', total, -total);

      -- ── CONTRA ───────────────────────────────────────────────────────────
      -- Dr Cash | Cr Bank — moving money between own accounts.
      seq := seq + 1;
      total := 5000;
      v_id := 'v-' || seq;
      INSERT INTO vouchers (voucher_id, company_id, voucher_number, voucher_type, voucher_date, narration, status, grand_total)
      VALUES (v_id, comp.company_id, 'CV-' || LPAD(seq::text,5,'0'), 'contra', d + 28, 'Cash withdrawn from bank (sample)', 'posted', total);
      INSERT INTO voucher_lines (voucher_id, company_id, line_no, ledger_id, dr_cr, amount, signed_amount) VALUES
        (v_id, comp.company_id, 1, comp.company_id || '-l-cash', 'Dr', total,  total),
        (v_id, comp.company_id, 2, comp.company_id || '-l-bank', 'Cr', total, -total);
      INSERT INTO bank_transactions (bank_txn_id, company_id, ledger_id, txn_date, narration, direction, amount, voucher_id, is_reconciled)
      VALUES ('bt-c-' || seq, comp.company_id, comp.company_id || '-l-bank', d + 28, 'Cash withdrawal (sample)', 'outflow', total, v_id, true);

      -- ── BUDGETS ──────────────────────────────────────────────────────────
      INSERT INTO budget_allocations (budget_id, company_id, ledger_id, period_month, allocated, department) VALUES
        ('bg-' || comp.company_id || '-' || m || '-p', comp.company_id, comp.company_id || '-l-purchase', d, 60000, 'Procurement'),
        ('bg-' || comp.company_id || '-' || m || '-r', comp.company_id, comp.company_id || '-l-rent',     d, 12000, 'Administration'),
        ('bg-' || comp.company_id || '-' || m || '-f', comp.company_id, comp.company_id || '-l-freight',  d,  9000, 'Logistics');
    END LOOP;

    -- One CANCELLED sales voucher per company. Its lines still balance; what it
    -- exists to prove is that a report which forgets `status = 'posted'` gets a
    -- visibly different answer.
    seq := seq + 1;
    v_id := 'v-' || seq;
    INSERT INTO vouchers (voucher_id, company_id, voucher_number, voucher_type, voucher_date, party_id, narration, status, grand_total)
    VALUES (v_id, comp.company_id, 'SV-CANCELLED-' || seq, 'sales', DATE '2025-09-15',
            comp.company_id || '-p-cirrus', 'Cancelled in error (sample)', 'cancelled', 118000);
    INSERT INTO voucher_lines (voucher_id, company_id, line_no, ledger_id, party_id, dr_cr, amount, signed_amount, gst_rate, taxable_value, tax_amount) VALUES
      (v_id, comp.company_id, 1, comp.company_id || '-p-cirrus', comp.company_id || '-p-cirrus', 'Dr', 118000, 118000, NULL, NULL, NULL),
      (v_id, comp.company_id, 2, comp.company_id || '-l-sales',  NULL, 'Cr', 100000, -100000, 18.00, 100000, 18000),
      (v_id, comp.company_id, 3, comp.company_id || '-l-cgst-out', NULL, 'Cr', 9000, -9000, 9.00, 100000, 9000),
      (v_id, comp.company_id, 4, comp.company_id || '-l-sgst-out', NULL, 'Cr', 9000, -9000, 9.00, 100000, 9000);
  END LOOP;
END $$;
