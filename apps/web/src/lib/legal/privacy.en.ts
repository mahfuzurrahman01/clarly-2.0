import { COMPANY } from "./company";
import type { LegalDocumentContent } from "./types";

export const privacyEn: LegalDocumentContent = {
  intro: [
    `This Privacy Policy explains how Clarly collects, uses, shares and protects personal data. Clarly is a customer-messaging platform that lets businesses answer their customers on WhatsApp, Facebook Messenger and Instagram with an AI agent. Clarly is operated by ${COMPANY.legalNameEn} (${COMPANY.legalNameAr}), Commercial Registration No. ${COMPANY.commercialRegistration}, ${COMPANY.addressEn} ("Clarly", "we", "us").`,
  ],
  sections: [
    {
      heading: "1. Our role",
      paragraphs: [
        "For the account data of businesses that sign up to Clarly, we are the controller.",
        "For the messages, contact details and order data of a business's own customers, the business is the controller and Clarly processes that data on the business's behalf and on its instructions. If you are a customer of a business that uses Clarly, contact that business about your data; we will help them answer your request.",
      ],
    },
    {
      heading: "2. Data we collect",
      bullets: [
        "Account data: name, work email, business name, password (stored hashed by our authentication provider), team members and their roles.",
        "Billing data: plan, invoices and payment status. Card details are handled by our payment processor; we never see or store full card numbers.",
        "Connected-channel data from Meta: when a business connects WhatsApp, a Facebook Page or an Instagram professional account, we receive the business account, phone number, page and Instagram account identifiers and names, and access tokens. Tokens are stored encrypted.",
        "Conversation data processed for businesses: messages, images, voice notes and other media their customers send, the customer's name, phone number or Meta page-scoped ID, and comments on the business's Facebook and Instagram posts.",
        "Commerce data: products, stock, orders and delivery status from stores and couriers a business connects.",
        "Technical data: IP address, browser type, pages visited in the console, and error reports used to keep the service working.",
        "Waitlist and contact forms: the name, email and business name you submit.",
      ],
    },
    {
      heading: "3. How we use data",
      bullets: [
        "To provide the service: receive customer messages, generate and send replies, hand conversations to a human agent, take orders and track deliveries.",
        "To run the business account: authentication, billing, support and service emails.",
        "To keep the service secure and reliable: abuse prevention, debugging and monitoring.",
        "To meet legal obligations.",
      ],
      after: [
        "We do not sell personal data. We do not use conversation data or data received from Meta for advertising, and we do not use it to train AI models.",
      ],
    },
    {
      heading: "4. Data from Meta platforms",
      paragraphs: [
        "Data we receive through WhatsApp, Facebook and Instagram APIs is used only to provide the messaging, comment-reply and channel-management features to the business that connected the account. We do not share it with third parties except the service providers listed below that help us run those features, and we do not combine it with data from other sources to profile people. We handle it in line with the Meta Platform Terms and Developer Policies.",
      ],
    },
    {
      heading: "5. AI processing",
      paragraphs: [
        "Incoming messages, images and voice notes are processed by language, vision and speech-recognition models to understand the customer and draft a reply, using the business's own product and policy information. Businesses can review conversations, take over from the AI at any time, and configure when the AI escalates to a human.",
      ],
    },
    {
      heading: "6. Service providers",
      paragraphs: ["We share data only with providers that process it for us under contract:"],
      bullets: [
        "Meta Platforms (WhatsApp Business Platform, Messenger, Instagram) to send and receive messages.",
        "Supabase for database, authentication and file storage.",
        "Render and Vercel for application hosting.",
        "Our dedicated GPU inference host, for the language and vision models we run ourselves.",
        "Audar for speech recognition of voice notes, and Cohere for ranking search results.",
        "Stripe for payments.",
        "Resend for transactional email.",
        "Sentry for error monitoring.",
        "Web3Forms for the website waitlist form.",
      ],
      after: [
        "We may also disclose data where required by law, or to protect the rights and safety of our users or the public.",
      ],
    },
    {
      heading: "7. International transfers",
      paragraphs: [
        "Our providers may process data outside your country, including in Singapore, the European Union and the United States. We rely on contractual safeguards for these transfers as required by the Saudi Personal Data Protection Law (PDPL) and other applicable law.",
      ],
    },
    {
      heading: "8. Retention",
      bullets: [
        "Conversation transcripts: deleted automatically after 90 days.",
        "Meta access tokens: kept until the channel is disconnected, the connecting user removes Clarly from their Facebook settings, or a deletion request is received.",
        "Account and billing data: kept while the account is active and afterwards for as long as tax and accounting law requires.",
        "Waitlist entries: deleted on request or when no longer needed.",
      ],
    },
    {
      heading: "9. Deleting your data",
      paragraphs: [
        "You can ask us to delete your data in any of these ways:",
      ],
      bullets: [
        `Email ${COMPANY.privacyEmail} from the address on your account. We confirm and complete the deletion within 30 days.`,
        "If you connected a Facebook Page or Instagram account: open Facebook Settings → Apps and Websites, remove Clarly, and choose to send a deletion request. We erase the access tokens tied to you immediately, and Meta gives you a confirmation code and a link where you can check the status.",
        "Business admins can close their workspace from the Clarly console. All of its data, including conversations, customers and uploaded files, is permanently erased 30 days later. Until then the closure can be undone.",
      ],
    },
    {
      heading: "10. Security",
      paragraphs: [
        "Data is encrypted in transit with TLS. Access tokens and other credentials are encrypted at rest. Access to production data is limited to staff who need it to run the service.",
      ],
    },
    {
      heading: "11. Your rights",
      paragraphs: [
        "Depending on where you live, including under the Saudi PDPL and the EU GDPR, you may have the right to access, correct, delete or obtain a copy of your personal data, to object to or restrict processing, and to withdraw consent. Contact us to use these rights. You may also complain to your data-protection authority, such as the Saudi Data & AI Authority (SDAIA).",
      ],
    },
    {
      heading: "12. Children",
      paragraphs: [
        "Clarly is a business service and is not directed to children under 18. We do not knowingly collect their data for our own purposes.",
      ],
    },
    {
      heading: "13. Changes",
      paragraphs: [
        "We will post any change to this policy on this page and update the date above. If a change is significant, we will also notify account owners by email.",
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
