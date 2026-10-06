// DI API v1.12 §9 "Scenarios for Sandbox Testing".
// saleType strings are what FBR expects in items[].saleType; buyer = default buyerRegistrationType.
const SCENARIOS = [
    { id: 'SN001', desc: 'Goods at standard rate to registered buyers', saleType: 'Goods at standard rate (default)', buyer: 'Registered' },
    { id: 'SN002', desc: 'Goods at standard rate to unregistered buyers', saleType: 'Goods at standard rate (default)', buyer: 'Unregistered', endConsumer: false },
    { id: 'SN003', desc: 'Sale of Steel (Melted and Re-Rolled)', saleType: 'Steel Melting and re-rolling' },
    { id: 'SN004', desc: 'Sale by Ship Breakers', saleType: 'Ship breaking' },
    { id: 'SN005', desc: 'Reduced rate sale', saleType: 'Goods at Reduced Rate' },
    { id: 'SN006', desc: 'Exempt goods sale', saleType: 'Exempt Goods' },
    { id: 'SN007', desc: 'Zero rated sale', saleType: 'Goods at zero-rate' },
    { id: 'SN008', desc: 'Sale of 3rd schedule goods', saleType: '3rd Schedule Goods' },
    { id: 'SN009', desc: 'Cotton Spinners purchase from Cotton Ginners (Textile)', saleType: 'Cotton Ginners' },
    { id: 'SN010', desc: 'Telecom services rendered or provided', saleType: 'Telecommunication services' },
    { id: 'SN011', desc: 'Toll Manufacturing sale by Steel sector', saleType: 'Toll Manufacturing' },
    { id: 'SN012', desc: 'Sale of Petroleum products', saleType: 'Petroleum Products' },
    { id: 'SN013', desc: 'Electricity Supply to Retailers', saleType: 'Electricity Supply to Retailers' },
    { id: 'SN014', desc: 'Sale of Gas to CNG stations', saleType: 'Gas to CNG stations' },
    { id: 'SN015', desc: 'Sale of mobile phones', saleType: 'Mobile Phones' },
    { id: 'SN016', desc: 'Processing / Conversion of Goods', saleType: 'Processing/ Conversion of Goods' },
    { id: 'SN017', desc: 'Sale of Goods where FED is charged in ST mode', saleType: 'Goods (FED in ST Mode)' },
    { id: 'SN018', desc: 'Services where FED is charged in ST mode', saleType: 'Services (FED in ST Mode)' },
    { id: 'SN019', desc: 'Services rendered or provided', saleType: 'Services' },
    { id: 'SN020', desc: 'Sale of Electric Vehicles', saleType: 'Electric Vehicle' },
    { id: 'SN021', desc: 'Sale of Cement / Concrete Block', saleType: 'Cement /Concrete Block' },
    { id: 'SN022', desc: 'Sale of Potassium Chlorate', saleType: 'Potassium Chlorate' },
    { id: 'SN023', desc: 'Sale of CNG', saleType: 'CNG Sales' },
    { id: 'SN024', desc: 'Goods listed in SRO 297(1)/2023', saleType: 'Goods as per SRO.297(|)/2023' },
    { id: 'SN025', desc: 'Drugs at fixed ST rate, serial 81 of Eighth Schedule Table 1', saleType: 'Non-Adjustable Supplies' },
    { id: 'SN026', desc: 'Sale to End Consumer by retailers (standard rate)', saleType: 'Goods at standard rate (default)', buyer: 'Unregistered', endConsumer: true },
    { id: 'SN027', desc: 'Sale to End Consumer by retailers (3rd schedule)', saleType: '3rd Schedule Goods', buyer: 'Unregistered', endConsumer: true },
    { id: 'SN028', desc: 'Sale to End Consumer by retailers (reduced rate)', saleType: 'Goods at Reduced Rate', buyer: 'Unregistered', endConsumer: true },
];

// Fallbacks if the FBR reference APIs (/pdi/v1/provinces, /pdi/v1/uom) are unreachable
const PROVINCES = ['PUNJAB', 'SINDH', 'KHYBER PAKHTUNKHWA', 'BALOCHISTAN', 'CAPITAL TERRITORY', 'AZAD JAMMU AND KASHMIR', 'GILGIT BALTISTAN'];
const UOMS = ['Numbers, pieces, units', 'KG', 'Liter', 'Meter', 'Square Metre', 'Dozen', 'Pair', 'Set', 'Bag', 'Carton', 'Packs', 'Bill of lading', 'Mega Watt', 'Kilowatt hour'];
const RATES = ['18%', '17%', '16%', '15%', '13%', '10%', '8%', '5%', '1%', '0%', 'Exempt'];

module.exports = { SCENARIOS, PROVINCES, UOMS, RATES };
