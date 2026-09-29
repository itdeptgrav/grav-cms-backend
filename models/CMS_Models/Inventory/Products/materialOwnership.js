// models/CMS_Models/Inventory/Products/materialOwnership.js
//
// A MATERIAL'S DEFAULT OWNERSHIP — WHOSE PROPERTY IT NORMALLY IS.
//
// The catalogue may say that a material is normally supplied by a customer
// and stays their property. That is a DEFAULT: it preselects the ownership a
// receipt is recorded with, and it says nothing about any stock already on
// the shelf. Physical ownership stays where it has always been decided — on
// the receipt (`GoodsReceipt.sourceType`), on the lot
// (`CustomerMaterialLot`) and on each movement
// (`RawItem.stockTransactions[].ownership`). Nothing here creates stock,
// moves it, revalues it or changes whose it is.
//
// The two words are the ones `StockIssuance.ownership` already uses, so a
// screen that reads either field reads one vocabulary.
"use strict";

const DEFAULT_OWNERSHIP = Object.freeze({
  COMPANY_OWNED: "COMPANY_OWNED",
  CUSTOMER_OWNED: "CUSTOMER_OWNED",
});

const DEFAULT_OWNERSHIP_VALUES = Object.freeze(Object.values(DEFAULT_OWNERSHIP));

/** What each value reads as. The same words Store's receipts use. */
const OWNERSHIP_WORDS = Object.freeze({
  [DEFAULT_OWNERSHIP.COMPANY_OWNED]: "Company owned",
  [DEFAULT_OWNERSHIP.CUSTOMER_OWNED]: "Customer property",
});

const isDefaultOwnership = (v) =>
  DEFAULT_OWNERSHIP_VALUES.includes(String(v ?? "").trim().toUpperCase());

/** An empty snapshot: what a company-owned material carries. */
const NO_OWNING_CUSTOMER = Object.freeze({ customerCode: "", customerLabel: "", customerName: "" });

module.exports = {
  DEFAULT_OWNERSHIP, DEFAULT_OWNERSHIP_VALUES, OWNERSHIP_WORDS, isDefaultOwnership,
  NO_OWNING_CUSTOMER,
};
