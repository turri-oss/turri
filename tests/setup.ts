// A test session writes no ledger and does not check for updates on npm.
process.env.TURRI_LEDGER ??= "off";
process.env.TURRI_UPDATE_CHECK ??= "off";
