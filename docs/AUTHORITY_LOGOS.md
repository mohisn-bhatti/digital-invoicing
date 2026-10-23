# Authority names and logos

Users recognise a tax authority by its name and logo, so the app shows them where it says which authority a product connects to:
the "What would you like to use?" screen (FBR for Digital Invoicing, PRA for Point of Sale), the *Service Tax Rates* admin page, and the "Connects to"
strip on the website. ([public/authorities.js](../public/authorities.js) holds the list; `src/modules.js` says which authority each product uses.)

## How a logo gets in

Put the authority's **official logo file** in [public/authorities/](../public/authorities/), named by its short name in lower case:
`fbr.png`, `pra.png` (and `srb.png`, `kpra.png`, `bra.png`, `psw.png`, `secp.png`, `eobi.png`, `essi.png` when those are used). A PNG about 200 pixels tall
with a clear or white background. That is all: no code change. Until a file is there, or if it cannot be loaded, the app shows the authority's short name on a
plain badge next to its full name, so a missing file is never a broken picture.

## Rules we follow

- **Official files only, shown as published.** Not redrawn, recoloured, cropped or taken from an image-search result (those are small, often altered copies of
  unknown origin). Take them from the authority's own site or ask the authority for its logo files. FBR's Digital Invoicing logo
  ([public/fbr-di-logo.jpg](../public/fbr-di-logo.jpg)) is separate: it is the logo FBR asks to be printed on a Digital Invoicing invoice and is used for that.
- **Say what they are for.** The chooser and the website say that ETAX is independent software, that the names and logos belong to their owners and that ETAX is
  not affiliated with or endorsed by them. Keep that wording wherever a logo is added.
- **Only authorities the app connects to are shown** (today FBR and PRA). The others in the list (SRB, KPRA, BRA, PSW, SECP, EOBI, ESSI) are there so a logo can be
  dropped in the day they are used; nothing shows them before that. Showing a body the product does not work with would mislead.
- **Not on the receipt.** PRA's documents do not require its logo on a receipt, and a colour logo prints badly on a thermal roll. The receipt has the PRA invoice number
  and the QR code that verifies it.

## Names to confirm

The feedback sheet also lists FPPRA and the provincial public-procurement authorities. They are not in the list: the app does not connect to them, and their exact
names should be confirmed before they are added.
