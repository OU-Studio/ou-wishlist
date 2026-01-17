import '@shopify/ui-extensions/preact';
import {render} from 'preact';

export default async (api) => {
  render(<Extension api={api} />, document.body);
};

function Extension({api}) {
  // customer is a SubscribableSignalLike; `.value` is the current value (preferred)
  const customer = api.authenticatedAccount?.customer?.value;
  const customerGid = customer?.id; // e.g. "gid://shopify/Customer/123456789"

  const customerId = customerGid
    ? customerGid.replace('gid://shopify/Customer/', '')
    : null;

  return (
    <s-page>
      <s-section>
        <s-banner>
          <s-text>
            Customer ID: {customerId ?? 'Not authenticated'}
          </s-text>
        </s-banner>
      </s-section>
    </s-page>
  );
}
