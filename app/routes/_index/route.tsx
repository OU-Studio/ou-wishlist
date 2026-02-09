import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  const pathPrefix = url.searchParams.get("path_prefix") || "";
  const isAppProxy = pathPrefix.startsWith("/apps/quote"); // proxy subpath

  // App Proxy requests must return 200 HTML (no redirect to /app)
  if (isAppProxy) {
    return {
      showForm: false,
      isAppProxy: true,
      shop: url.searchParams.get("shop"),
      loggedInCustomerId: url.searchParams.get("logged_in_customer_id"),
    };
  }

  // Normal behavior for direct app visits
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login), isAppProxy: false };
};

export default function App() {
  const data = useLoaderData<typeof loader>();

  if (data.isAppProxy) {
    return (
      <div style={{ padding: 24 }}>
        <h1>Quote page</h1>
        <p>Shop: {data.shop}</p>
        <p>Customer: {data.loggedInCustomerId ?? "not logged in"}</p>
      </div>
    );
  }

  return (
    <div className={styles.index}>
      
    </div>
  );
}
