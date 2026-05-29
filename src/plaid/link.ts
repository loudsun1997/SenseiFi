import { plaidClient } from "./client.js";
import { CountryCode, Products } from "plaid";
import { config } from "../config.js";

export function getCountryCodes(): CountryCode[] {
  const codes = config.plaidCountries
    .map(c => c.toUpperCase() as keyof typeof CountryCode)
    .filter(c => c in CountryCode)
    .map(c => CountryCode[c]);
  return codes.length > 0 ? codes : [CountryCode.Us];
}

/** Create a link token for initializing Plaid Link */
export async function createLinkToken(products: Products[] = [Products.Transactions]) {
  const resp = await plaidClient.linkTokenCreate({
    user: { client_user_id: "ray-user" },
    client_name: "Ray Finance",
    products,
    optional_products: [Products.Investments, Products.Liabilities],
    country_codes: getCountryCodes(),
    language: "en",
  });
  return resp.data.link_token;
}

/** Create a link token for Plaid update mode account selection on an existing Item. */
export async function createAccountSelectionUpdateLinkToken(accessToken: string) {
  const resp = await plaidClient.linkTokenCreate({
    user: { client_user_id: "ray-user" },
    client_name: "Ray Finance",
    access_token: accessToken,
    country_codes: getCountryCodes(),
    language: "en",
    update: {
      account_selection_enabled: true,
    },
  } as any);
  return resp.data.link_token;
}

/** Exchange a public token from Plaid Link for an access token */
export async function exchangeToken(publicToken: string) {
  const resp = await plaidClient.itemPublicTokenExchange({
    public_token: publicToken,
  });
  return {
    accessToken: resp.data.access_token,
    itemId: resp.data.item_id,
  };
}
