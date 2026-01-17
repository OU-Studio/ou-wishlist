import { authenticate } from "../../shopify.server";
import { asString } from "../../utils/api.server";

export async function loader({ request }: { request: Request }) {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const query = asString(url.searchParams.get("query"));

  const res = await admin.graphql(
    `#graphql
      query Customers($q: String!) {
        customers(first: 20, query: $q) {
          edges {
            node {
              id
              displayName
              email
            }
          }
        }
      }
    `,
    { variables: { q: query || "" } }
  );

  const json: any = await res.json();
  const edges = json?.data?.customers?.edges ?? [];
  const customers = edges.map((e: any) => e.node);

  return Response.json({ customers }, { status: 200 });
}
