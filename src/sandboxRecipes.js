// Test invoices for FBR's sandbox scenarios (spec v1.12 §9), one per scenario, with data FBR's sandbox accepted
// (validated 12-Oct-2026 with a manufacturer's sandbox token, sale types / rates / SROs from FBR's own lists).
// At run time each one is checked against FBR's live lists (pickers below) so a renamed sale type, a changed rate or
// SRO list doesn't break it. confirmed: false = FBR didn't accept it for that seller (depends on the seller's own
// business type, or needs a field not in the spec) — still tried, shown as "not confirmed".
const ICE = { hsCode: '2201.9000', productDescription: 'Ice block', uoM: 'Liter' };
const OXEN = { hsCode: '0102.2930', productDescription: 'Live oxen', uoM: 'Numbers, pieces, units' };

const RECIPES = {
    SN001: { buyer: 'REG', item: { ...ICE, saleType: 'Goods at standard rate (default)', rate: '18%', quantity: 100, unitPrice: 20 } },
    SN002: { buyer: 'UNREG', item: { ...ICE, saleType: 'Goods at standard rate (default)', rate: '18%', quantity: 50, unitPrice: 20 } },
    SN003: { buyer: 'UNREG', item: { hsCode: '7206.1000', productDescription: 'Steel ingots', uoM: 'MT', saleType: 'Steel melting and re-rolling', rate: '18%', quantity: 1, unitPrice: 170000 },
        note: 'FBR enforces a minimum price per MT (error 0059)' },
    SN004: { buyer: 'UNREG', item: { hsCode: '7204.4910', productDescription: 'Ship breaking scrap', uoM: 'MT', saleType: 'Ship breaking', rate: '18%', quantity: 1, unitPrice: 160000 },
        note: 'FBR enforces a minimum price per MT (error 0059)' },
    SN005: { buyer: 'UNREG', item: { ...OXEN, saleType: 'Goods at Reduced Rate', rate: '1%', quantity: 1, unitPrice: 10000, sroScheduleNo: 'EIGHTH SCHEDULE Table 1', sroItemSerialNo: '82' } },
    SN006: { buyer: 'UNREG', item: { ...OXEN, saleType: 'Exempt goods', rate: 'Exempt', quantity: 1, unitPrice: 10000, sroScheduleNo: '6th Schd Table I', sroItemSerialNo: '100' } },
    SN007: { buyer: 'UNREG', item: { ...ICE, saleType: 'Goods at zero-rate', rate: '0%', quantity: 100, unitPrice: 20, sroScheduleNo: '327(I)/2008', sroItemSerialNo: '1' } },
    SN008: { buyer: 'UNREG', item: { hsCode: '3306.1090', productDescription: 'Toothpaste', uoM: 'Numbers, pieces, units', saleType: '3rd Schedule Goods', rate: '5%', quantity: 10, unitPrice: 100,
        fixedNotifiedValueOrRetailPrice: 1200, sroScheduleNo: '3rd Schedule goods', sroItemSerialNo: '51' } },
    SN009: { buyer: 'UNREG', confirmed: false, item: { hsCode: '5201.0050', productDescription: 'Raw cotton', uoM: 'KG', saleType: 'Cotton ginners', rate: '18%', quantity: 10, unitPrice: 100 },
        note: 'FBR answered "Provide Valid Sale Type" for a manufacturer — a cotton spinner\'s purchase' },
    SN010: { buyer: 'UNREG', item: { hsCode: '9801.1000', productDescription: 'Telecom service', uoM: 'Numbers, pieces, units', saleType: 'Telecommunication services', rate: '17%', quantity: 10, unitPrice: 100 } },
    SN011: { buyer: 'UNREG', confirmed: false, item: { hsCode: '7210.6110', productDescription: 'Steel sheet (toll)', uoM: 'KG', saleType: 'Toll Manufacturing', rate: '18%', quantity: 10, unitPrice: 100 },
        note: 'FBR answered "Provided scenario does not exists" for a manufacturer in another sector' },
    SN012: { buyer: 'UNREG', confirmed: false, item: { hsCode: '2710.1220', productDescription: 'Petroleum product', uoM: 'KG', saleType: 'Petroleum Products', rate: 'Exempt', quantity: 10, unitPrice: 100,
        sroScheduleNo: '6th Schd Table I', sroItemSerialNo: '176(i)' }, note: 'FBR asks for a "Petroleum Levy On" field that is not in the DI spec v1.12 (error 0129)' },
    SN013: { buyer: 'UNREG', item: { hsCode: '2716.0000', productDescription: 'Electricity', uoM: 'KWH', saleType: 'Electricity Supply to Retailers', rate: '5%', quantity: 10, unitPrice: 100 } },
    SN014: { buyer: 'UNREG', item: { hsCode: '2711.2100', productDescription: 'Natural gas', uoM: 'KG', saleType: 'Gas to CNG stations', rate: '18%', quantity: 10, unitPrice: 100 } },
    SN015: { buyer: 'UNREG', item: { hsCode: '8517.1390', productDescription: 'Mobile phone', uoM: 'Numbers, pieces, units', saleType: 'Mobile Phones', rate: '18%', quantity: 1, unitPrice: 15000,
        sroScheduleNo: 'NINTH SCHEDULE', sroItemSerialNo: '1(A)' } },
    SN016: { buyer: 'UNREG', item: { ...ICE, saleType: 'Processing/Conversion of Goods', rate: '5%', quantity: 100, unitPrice: 20 } },
    SN017: { buyer: 'UNREG', item: { hsCode: '2710.1240', productDescription: 'White spirit', uoM: 'Liter', saleType: 'Goods (FED in ST Mode)', rate: '18% and Rs. 80 per Liter', quantity: 10, unitPrice: 100 } },
    SN018: { buyer: 'UNREG', item: { hsCode: '9801.1000', productDescription: 'Service', uoM: 'Numbers, pieces, units', saleType: 'Services (FED in ST Mode)', rate: '8%', quantity: 10, unitPrice: 100 } },
    SN019: { buyer: 'UNREG', item: { hsCode: '9801.1000', productDescription: 'Service', uoM: 'Numbers, pieces, units', saleType: 'Services', rate: '0%', quantity: 10, unitPrice: 100,
        sroScheduleNo: 'FIFTH SCHEDULE', sroItemSerialNo: '1(i)' } },
    SN020: { buyer: 'UNREG', item: { hsCode: '8703.6021', productDescription: 'Electric vehicle', uoM: 'Numbers, pieces, units', saleType: 'Electric Vehicle', rate: '1%', quantity: 1, unitPrice: 10000,
        sroScheduleNo: '6th Schd Table III', sroItemSerialNo: '20' } },
    SN021: { buyer: 'UNREG', item: { hsCode: '6810.1100', productDescription: 'Concrete block', uoM: 'KG', saleType: 'Cement /Concrete Block', rate: 'Rs.3', quantity: 100, unitPrice: 50 } },
    SN022: { buyer: 'UNREG', item: { hsCode: '2829.1910', productDescription: 'Potassium chlorate', uoM: 'KG', saleType: 'Potassium Chlorate', rate: '18% along with rupees 60 per kilogram', quantity: 10, unitPrice: 100,
        sroScheduleNo: 'EIGHTH SCHEDULE Table 1', sroItemSerialNo: '56' } },
    SN023: { buyer: 'UNREG', item: { hsCode: '2711.2100', productDescription: 'CNG', uoM: 'KG', saleType: 'CNG Sales', rate: 'Rs.200', quantity: 10, unitPrice: 100,
        sroScheduleNo: '581(1)/2024', sroItemSerialNo: 'Region-I' } },
    SN024: { buyer: 'UNREG', item: { hsCode: '0101.2100', productDescription: 'Goods under SRO 297', uoM: 'Numbers, pieces, units', saleType: 'Goods as per SRO.297(|)/2023', rate: '25%', quantity: 1, unitPrice: 10000,
        sroScheduleNo: '297(I)/2023-Table-I', sroItemSerialNo: '12' } },
    SN025: { buyer: 'UNREG', confirmed: false, item: { hsCode: '3003.3900', productDescription: 'Medicine', uoM: 'KG', saleType: 'Non-Adjustable Supplies', rate: '0%', quantity: 10, unitPrice: 100,
        sroScheduleNo: 'Eighth Schedule Table 1', sroItemSerialNo: '81' }, note: 'FBR: manufacturers cannot add non-adjustable supplies (error 0093)' },
    SN026: { buyer: 'UNREG', endConsumer: true, item: { hsCode: '2201.1020', productDescription: 'Mineral water', uoM: 'Liter', saleType: 'Goods at standard rate (default)', rate: '18%', quantity: 10, unitPrice: 100 } },
    SN027: { buyer: 'UNREG', endConsumer: true, item: { hsCode: '3401.1910', productDescription: 'Soap', uoM: 'KG', saleType: '3rd Schedule Goods', rate: '5%', quantity: 10, unitPrice: 100,
        fixedNotifiedValueOrRetailPrice: 1200, sroScheduleNo: '3rd Schedule goods', sroItemSerialNo: '51' } },
    SN028: { buyer: 'UNREG', endConsumer: true, item: { ...OXEN, saleType: 'Goods at Reduced Rate', rate: '1%', quantity: 1, unitPrice: 10000, sroScheduleNo: 'EIGHTH SCHEDULE Table 1', sroItemSerialNo: '82' } },
};

// Matching against FBR's live lists: same text ignoring case and spaces; otherwise the first item FBR offers
const key = v => String(v ?? '').toLowerCase().replace(/\s+/g, '');
const pick = (wanted, list, text = x => x) => (list || []).find(x => key(text(x)) === key(wanted)) || null;

/** FBR's own spelling of the sale type, or null when FBR doesn't list it */
const pickSaleType = (name, liveNames) => { const hit = pick(name, liveNames); return hit ? String(hit).trim() : null; };
/** the recipe's rate if FBR still allows it for the sale type, else FBR's first rate: { id, desc } */
const pickRate = (desc, rates) => pick(desc, rates, r => r.desc) || (rates && rates[0]) || null;
/** SRO / Schedule: the recipe's one if FBR lists it for the rate, else FBR's first (null when FBR lists none) */
const pickSro = (desc, sros) => pick(desc, sros, s => s.desc) || (sros && sros[0]) || null;
/** item serial in the chosen SRO: the recipe's one if listed, else FBR's first */
const pickSerial = (desc, items) => pick(desc, items, i => i.desc) || (items && items[0]) || null;
/** unit: the recipe's one if FBR allows it for the HS code, else FBR's first */
const pickUom = (uom, uoms) => (!uoms || !uoms.length ? uom : pick(uom, uoms) || uoms[0]);

module.exports = { RECIPES, pickSaleType, pickRate, pickSro, pickSerial, pickUom };
