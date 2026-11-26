// Price text helpers shared by the apps: a figure in cents, rounded to a tenth, written with the cent sign.
export const tenths = (cents) => Math.round(cents * 10);
export const fmt = (cents) => `${Number.isInteger(cents) ? cents : (Math.round(cents * 10) / 10).toString()}¢`;
