import { COMPANY } from "./company";
import type { LegalDocumentContent } from "./types";

export const termsEn: LegalDocumentContent = {
  intro: [
    `These Terms of Service govern your use of Clarly, a service operated by ${COMPANY.legalNameEn} (${COMPANY.legalNameAr}), Commercial Registration No. ${COMPANY.commercialRegistration}, ${COMPANY.addressEn}. By creating an account or using Clarly you agree to these terms on behalf of yourself and the business you represent ("you").`,
  ],
  sections: [
    {
      heading: "1. The service",
      paragraphs: [
        "Clarly lets businesses connect WhatsApp, Facebook Messenger and Instagram accounts and answer customers with an AI agent that uses the business's own product, order and policy information, with human agents able to take over at any time.",
      ],
    },
    {
      heading: "2. Accounts",
      paragraphs: [
        "You must be at least 18 and authorised to act for your business. Keep your login details secure and tell us at once about any unauthorised use. You are responsible for everything done under your account, including by team members you invite.",
      ],
    },
    {
      heading: "3. Your responsibilities",
      bullets: [
        "Comply with the WhatsApp Business Messaging Policy, WhatsApp Commerce Policy, Meta Platform Terms and Community Standards, and all applicable law, including consumer-protection, e-commerce and personal-data law.",
        "Obtain the opt-ins and consents required to message your customers, and honour opt-out requests.",
        "Make sure the product, price and policy information you give the agent is accurate.",
        "Tell your customers, in your own privacy notice, that you use Clarly and AI to handle their messages.",
      ],
    },
    {
      heading: "4. Acceptable use",
      paragraphs: ["You must not use Clarly to:"],
      bullets: [
        "send spam or unsolicited bulk messages;",
        "sell or promote goods or services prohibited by Meta's commerce policies or by law;",
        "harass, deceive or impersonate anyone;",
        "interfere with, probe or reverse-engineer the service.",
      ],
    },
    {
      heading: "5. AI-generated replies",
      paragraphs: [
        "Replies are generated automatically and may occasionally be wrong or incomplete. You remain responsible for the messages sent from your accounts. Use the escalation and approval settings to keep a human in the loop where accuracy matters, such as prices, refunds and medical, legal or safety questions.",
      ],
    },
    {
      heading: "6. Fees",
      paragraphs: [
        "Subscription fees are shown on our pricing page and billed in advance through our payment processor. Charges Meta makes for WhatsApp messages are billed by Meta directly to the payment method on your WhatsApp Business Account and are not part of our fees. Fees are non-refundable except where the law requires otherwise. Prices exclude VAT, which is added where applicable.",
      ],
    },
    {
      heading: "7. Your data",
      paragraphs: [
        "You own your data and your customers' data. You grant us the rights needed to host and process it to provide the service. We handle personal data as described in our Privacy Policy, and when we process your customers' data we act on your instructions as your processor.",
      ],
    },
    {
      heading: "8. Third-party services",
      paragraphs: [
        "Clarly relies on Meta, online stores, couriers and other third parties. Their terms apply to your use of them, and we are not responsible for their availability, policy changes, or any action they take on your accounts, such as a messaging limit or a ban.",
      ],
    },
    {
      heading: "9. Our intellectual property",
      paragraphs: [
        "Clarly's software, design and brand belong to us. These terms give you a limited, non-exclusive, non-transferable right to use the service during your subscription.",
      ],
    },
    {
      heading: "10. Suspension and termination",
      paragraphs: [
        "You may close your workspace at any time from the console. We may suspend or terminate access if you breach these terms, fail to pay, or put the service, Meta or other users at risk. After closure your data is erased as described in the Privacy Policy.",
      ],
    },
    {
      heading: "11. Disclaimers and liability",
      paragraphs: [
        "The service is provided \"as is\". To the extent the law allows, we disclaim implied warranties, and we are not liable for indirect or consequential losses, lost profits or lost data. Our total liability for any claim is limited to the fees you paid us in the 12 months before the claim.",
      ],
    },
    {
      heading: "12. Governing law",
      paragraphs: [
        "These terms are governed by the laws of the Kingdom of Saudi Arabia. Disputes go to the competent courts in Riyadh.",
      ],
    },
    {
      heading: "13. Changes",
      paragraphs: [
        "We may update these terms. We will post the new version here and, for significant changes, email account owners at least 14 days before they take effect. Continuing to use Clarly after that means you accept them.",
      ],
    },
    {
      heading: "14. Contact",
      paragraphs: [
        `${COMPANY.legalNameEn}, ${COMPANY.addressEn}. Email: ${COMPANY.privacyEmail}. Phone: ${COMPANY.phone}.`,
      ],
    },
  ],
};
