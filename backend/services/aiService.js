/**
 * AI Chat Controller - Gemini API Integration
 * Uses Google's Gemini 2.5 Flash model for pet care advice
 */

const env = require('../config/env');
const logger = require('../utils/logger');

const GEMINI_API_KEY = env.gemini.apiKey;
const GEMINI_MODEL = env.gemini.model;

if (!GEMINI_API_KEY) {
  logger.warn('ai.gemini_api_key_missing');
}
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const UNKNOWN_PETHUB_RESPONSE = "I'm not sure based on the current PetHub system.";

const EMERGENCY_KEYWORDS = [
  'blood', 'bleeding', 'seizure', 'convulsion', 'poison', 'toxic', 'toxin',
  'not breathing', 'cannot breathe', 'choking', 'collapse', 'collapsed', 'unconscious',
  'severe bleeding', 'severe vomiting', 'severe diarrhea', 'severe pain',
  'broken bone', 'fracture', 'trauma', 'accident', 'hit by', 'ingested',
  'extreme lethargy', 'unresponsive', 'passing out', 'fainting'
];
const ROUTINE_PHRASES_WITH_EMERGENCY_WORDS = /\bblood ?(tests?|work|panels?|chemistry|count)\b|\b(potty|house|toilet|litter)[- ]?(training )?accidents?\b/g;
// The same emergencies described in Tagalog / Taglish; these are answered in Tagalog
const TAGALOG_EMERGENCY_KEYWORDS = [
  'nalason', 'lason', 'nagdudugo', 'dumudugo', 'kombulsyon', 'nangingisay', 'hindi makahinga', 'hindi humihinga',
  'nabulunan', 'nawalan ng malay', 'hinimatay', 'nasagasaan'
];
const EMERGENCY_RESPONSE = "🚨 **EMERGENCY - Your pet needs immediate veterinary care!**\n\nPlease contact an emergency vet clinic NOW. Do not wait.\n\nOnce stabilized, book urgent appointment in your **Appointments** page.\n\nFor emergency care, contact a local emergency vet clinic or animal poison control.\n\nYour pet's life may depend on immediate action. ⚠️";
const TAGALOG_EMERGENCY_RESPONSE = "🚨 **EMERGENCY - Kailangan agad ng beterinaryo ang alaga mo!**\n\nMakipag-ugnayan NGAYON sa emergency vet clinic. Huwag nang maghintay.\n\nKapag stable na siya, mag-book ng agarang appointment sa **Appointments** page.\n\nPara sa emergency care, tumawag sa pinakamalapit na emergency vet clinic o animal poison control.\n\nMaaaring nakasalalay ang buhay ng alaga mo sa agarang aksyon. ⚠️";
const HUMAN_BITE_SOURCE = Object.freeze({
  title: 'WHO: Rabies',
  url: 'https://www.who.int/news-room/fact-sheets/detail/rabies'
});

function isHumanAnimalBiteReport(message) {
  const text = String(message || '').toLowerCase();
  const mentionsAnimal = /\b(dog|puppy|cat|kitten|animal|aso|tuta|pusa|hayop)\b/.test(text);
  const mentionsBiteOrAttack = /\b(bite|bites|bit|bitten|attacked|attack|kagat|nakagat|kinagat|kumagat|kagatin|nakalmot|kinamot)\b/.test(text);
  return mentionsAnimal && mentionsBiteOrAttack;
}

function shouldUseGoogleSearch(message) {
  return /\b(rabies|rabid|bite|bitten|kagat|nakagat|kinagat|vaccine|vaccination|bakuna|poison|toxin|toxic|lason|medicine|medication|gamot|dosage|dose|treatment|symptom|sintomas|vomit|pagsusuka|diarrhea|hirap huminga|emergency|outbreak|recall|latest|current|infectious|contagious)\b/i
    .test(String(message || ''));
}

function normalizeConversationHistory(history = []) {
  if (!Array.isArray(history)) return [];
  const normalized = [];
  let totalCharacters = 0;
  history.slice(-12).forEach(entry => {
    const role = entry?.role === 'user' ? 'user' : (entry?.role === 'model' || entry?.role === 'assistant' ? 'model' : '');
    const text = String(entry?.text || entry?.content || '').trim().slice(0, 1200);
    if (!role || !text || totalCharacters >= 8000) return;
    const boundedText = text.slice(0, 8000 - totalCharacters);
    normalized.push({ role, parts: [{ text: boundedText }] });
    totalCharacters += boundedText.length;
  });

  const firstUserIndex = normalized.findIndex(entry => entry.role === 'user');
  return firstUserIndex < 0 ? [] : normalized.slice(firstUserIndex);
}

function extractGroundingSources(metadata) {
  const chunks = Array.isArray(metadata?.groundingChunks) ? metadata.groundingChunks : [];
  const seen = new Set();
  const sources = [];
  chunks.forEach(chunk => {
    const web = chunk?.web || chunk?.retrievedContext || {};
    const rawUrl = String(web.uri || web.url || '').trim();
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== 'https:' || url.username || url.password || seen.has(url.href)) return;
      seen.add(url.href);
      sources.push({
        title: String(web.title || url.hostname).trim().slice(0, 200),
        url: url.href
      });
    } catch (error) {
      // Ignore malformed or non-HTTPS grounding entries.
    }
  });
  return sources.slice(0, 5);
}

const MINI_FAQ = {
  // ==================== PETHUB BASICS ====================
  'what is pethub': "**PetHub** helps users manage pet profiles, book appointments, review medical records, send contact messages, and use user/admin dashboards.",
  'what does pethub do': "PetHub supports these current features: **pet profiles**, **appointment booking**, **medical records**, **contact/messages**, and **admin/user dashboards**.",
  'what features does pethub have': "PetHub supports these current features: **pet profiles**, **appointment booking**, **medical records**, **contact/messages**, and **admin/user dashboards**.",
  'what services does pethub offer': "The clinic's current service list and online booking status are shown on the **Services** page. The list is managed by the clinic and may change. For prices or questions, use the **Contact** page.",
  'what services does the clinic offer': "Please check the **Services** page for the clinic's current service list and which services can be booked online. For questions, use the **Contact** page.",
  'what grooming services are available': "The **Services** page shows the current grooming list, applicable pets, and online booking status.",
  'do you offer vaccination': "Check the current **Services** page for listed services. For vaccine availability or medical advice, contact the clinic or your veterinarian.",
  'how much does grooming cost': "PetHub doesn't list prices. Please ask the clinic through the **Contact** page.",
  'how much does it cost': "PetHub doesn't list prices. Please ask the clinic through the **Contact** page.",
  'how long does grooming take': "Check the **Services** page for a confirmed duration. If no duration is shown, ask the clinic through the **Contact** page.",
  'what are your opening hours': "PetHub doesn't list the clinic's opening hours. Please ask the clinic through the **Contact** page.",
  'where is the clinic': "PetHub doesn't list the clinic's address. Please ask the clinic through the **Contact** page.",
  'do you accept rabbits': "The clinic cares for **dogs and cats** only, so PetHub pet profiles and bookings are for dogs and cats.",
  'why should i use pethub': "PetHub can help keep pet profiles, appointment requests, medical records, and dashboard views organized in one system.",
  'is pethub free': "I'm not sure based on the current PetHub system.",
  'what makes pethub different': "PetHub brings pet profiles, appointment booking, medical records, contact/messages, and dashboards into the same system.",
  'is pethub hipaa compliant': "I'm not sure based on the current PetHub system.",
  'hipaa compliant': "I'm not sure based on the current PetHub system.",
  
  // ==================== GETTING STARTED ====================
  'how do i sign up': "Visit **Register** and fill in every field: your account details (name, email, password) and your personal and contact details (date of birth, gender, contact number and home address). Verify your email with the 6-digit code we send, then log in to your **Dashboard**.",
  'how do i edit my details': "Open the **Overview** of your **Pet Owner Dashboard**, go to **Your details** and choose **Edit details**. Your email can't be changed there; to change your password, use **Forgot password?** on the **Login** page.",
  'why do you need my address': "The registration form asks for a contact number and address. The current system summary does not explain why the clinic needs each field; use the **Contact** page to ask the clinic.",
  'how do i login': "Go to **Login**, enter your registered email and password, click Login. You'll land on the **Overview** of your **Pet Owner Dashboard**, with your pets and upcoming appointments. 🔐",
  'how do i logout': "Choose **Log out** in the dashboard sidebar (at the top of the screen on phones). You'll be logged out and taken to the **Login** page.",
  'what happens after i sign up': "After registration: 1️⃣ Verify email if needed 2️⃣ Log in 3️⃣ Land on the **Overview** of your **Pet Owner Dashboard** 4️⃣ Open **My Pets** to add your first pet 5️⃣ Open **Appointments** to book when online booking is open 🚀",
  'can i have multiple accounts': "We recommend one account per person. Use that one account to manage all your pets! If needed, create a new email and sign up separately.",
  'is my account secure': "I'm not sure based on the current PetHub system.",
  
  // ==================== PET MANAGEMENT ====================
  'how do i add a pet': "Go to **My Pets** → **Add a pet** → **Register a new pet**: Name, Species (**Dog** or **Cat**), Breed (optional) and Age (whole years, 1 to 25) → click **Add Pet**. If one of your profiles looks like the same pet, PetHub shows it first so you don't add it twice. 🎉",
  'what info should i add for my pet': "Add the pet details PetHub asks for: pet name, species, breed if you know it, and age in whole years. Medical records are added by the clinic after completed visits; you can read them, but not add or change them.",
  'can i add multiple pets': "Yes. Register each pet under **My Pets** → **Add a pet** → **Register a new pet**. Two pets can share a name; if a new profile looks like one you already have, PetHub asks you to confirm it's a different pet before saving it.",
  'how do i edit a pets profile': "Open **My Pets**, choose **View details** on the pet, then **Edit profile** to correct its name, species, breed or age. Official medical records can only be changed by the clinic.",
  'how do i delete a pet': "Open **My Pets**, choose **View details** on the pet, then **Delete profile** and confirm. A profile can only be deleted while it has no appointments or official medical records in PetHub; otherwise it is kept so that history stays linked, and you can use the **Contact** page if it needs to be removed.",
  'what if i add my pet by wrong name': "Open **My Pets**, choose **View details** on the pet, then **Edit profile** and correct the name. There's no need to add the pet again.",
  'the species options are limited': "The clinic cares for 🐕 **dogs** and 🐈 **cats** only, so those are the species PetHub pet profiles accept.",
  'how do i track my pets health': "Open **Pet Health & AI Assistant** in your **Pet Owner Dashboard** to read the official records the clinic has added for each pet (weight, vaccination status, treatment and notes). You can also use **appointment booking** when a vet visit is needed.",
  'can i share pet profiles with my vet': "I'm not sure based on the current PetHub system.",
  
  // ==================== APPOINTMENTS ====================
  'how do i book an appointment': "Go to **Appointments**, choose your pet, a service offered for it, a date and a time, and submit the request. The status starts as **Pending** until the clinic reviews it. A service can only be booked online once the clinic has confirmed how long it takes.",
  'what appointment services are available': "The **Services** page shows the current catalog and which services are open for online booking. In **Appointments**, choose your pet to see which open services apply to them.",
  'what does pending mean': "**Pending** means your appointment request was submitted and is waiting for admin review. Check your **Appointments** page for updates.",
  'what does approved mean': "**Approved** means the appointment request has been accepted in PetHub. Check your **Appointments** page or dashboard for the current details.",
  'what does completed mean': "**Completed** means the appointment was marked finished in PetHub. It can remain visible as part of appointment history if the current system shows it.",
  'what does cancelled mean': "**Cancelled** means the clinic cancelled the appointment request or the appointment. To book again, use the **Appointments** page when online booking is open, or contact the clinic.",
  'how long does approval take': "I'm not sure based on the current PetHub system.",
  'can i cancel an appointment': "You can cancel your own Pending or Approved appointment from **Appointments** at least 2 hours before its scheduled start. Contact the clinic for rescheduling or a late cancellation.",
  'can i reschedule after approval': "I'm not sure based on the current PetHub system.",
  'what if i miss an appointment': "Check your appointment status in PetHub and contact the clinic or admin through the available contact/messages flow if you need help.",
  'can i book multiple appointments': "I'm not sure based on the current PetHub system.",
  'what time should i book appointments': "I'm not sure based on the current PetHub system.",
  
  // ==================== DASHBOARD & FEATURES ====================
  'what is my dashboard': "Your **Pet Owner Dashboard** has four sections: **Overview**, **My Pets**, **Appointments**, and **Pet Health & AI Assistant**.",
  'what can i see on the dashboard': "The **Overview** shows your pets, your upcoming appointments and their status, recent account activity and your details. **My Pets**, **Appointments** and **Pet Health & AI Assistant** have the rest.",
  'how do i navigate pethub': "The website's top menu has **Home**, **About**, **Services** and **Contact**. After you log in, the dashboard sidebar (a bar at the top on phones) has **Overview**, **My Pets**, **Appointments** and **Pet Health & AI Assistant**, plus **Log out**. 🌙 The dark mode toggle is at the bottom right.",
  'where is the dark mode toggle': "Bottom-right corner of any page! 🌙 Click to switch between light and dark modes. Your preference saves automatically! 🌗",
  'what is the home page': "Landing page with PetHub intro, features overview, and Call-to-Action buttons to Register or Login. Great place to learn about PetHub before creating an account! 🏠",
  'what is the about page': "The **About** page shares general information about PetHub.",
  'what is the services page': "The **Services** page shows the current clinic catalog, applicable species, confirmed durations when available, and online booking status.",
  'what is the contact page': "The **Contact** page lets users send messages or inquiries through PetHub.",
  
  // ==================== SECURITY & PRIVACY ====================
  'is my pet data secure': "PetHub uses account login and database-backed storage for system records, but I can't claim HIPAA compliance, medical certification, or a specific security standard.",
  'what security does pethub have': "I'm not sure based on the current PetHub system.",
  'what data does pethub collect': "I'm not sure based on the current PetHub system.",
  'can vets see my pet records': "I'm not sure based on the current PetHub system.",
  'does pethub share my data': "I'm not sure based on the current PetHub system.",
  'is my password stored safely': "I'm not sure based on the current PetHub system.",
  
  // ==================== AI ASSISTANT ====================
  'who are you': "I'm **PetHub AI Copilot**. I can help explain current PetHub features and provide general pet wellness information.",
  'what can you help me with': "I can help with general pet wellness questions and current PetHub features: **pet profiles**, **appointment booking**, **medical records**, **contact/messages**, and **admin/user dashboards**.",
  'are you available 24/7': "I'm not sure based on the current PetHub system.",
  'can you replace my vet': "No way! I'm an **informational assistant**, not a veterinarian. 🏥 For medical emergencies, go to an emergency vet immediately! Use me for wellness guidance before/after vet visits!",
  'what if i have an emergency': "Contact your nearest **emergency vet clinic immediately**! 🚨 I can provide guidance, but NOTHING replaces professional medical care for emergencies. Call 911 or poison control if needed!",
  'how accurate is your advice': "I provide general wellness information only. I am not a veterinarian, and important health decisions should be checked with a vet.",
  'can you diagnose my pet': "No. I can't diagnose your pet. I can share general wellness information and suggest when to contact a veterinarian.",
  'can pethub diagnose my pet': "No. PetHub AI cannot diagnose pets. It can share general wellness information, and medical concerns should be checked with a veterinarian.",
  'does pethub guarantee treatment': "No. PetHub does not promise treatment outcomes. For medical concerns, consult a veterinarian.",
  
  // ==================== ADMIN FEATURES (if user asks) ====================
  'what can admins do': "Admins use the **Admin Dashboard**: **Overview**, **Appointment Management**, **Pet Owners & Records**, and **System Management** (users, contact messages, activity logs and the service catalog). The separate **Breed Catalog** page manages breed suggestions.",
  'how do appointments get approved': "Admins review requests in **Appointment Management** on the **Admin Dashboard** and approve or cancel them. Approval depends on admin review and on the schedule being free.",
  'what is the admin dashboard': "The **Admin Dashboard** is the admin area with four sections: **Overview**, **Appointment Management**, **Pet Owners & Records**, and **System Management**.",
  
  // ==================== TROUBLESHOOTING ====================
  'i forgot my password': "On the **Login** page, choose **Forgot password?**, enter your email, and use the 6-digit code we email you to set a new password.",
  'my appointment is not showing': "Try refreshing the page and checking your **Appointments** page again. If it still does not appear, use **Contact/messages** or ask an admin.",
  'why is my appointment still pending': "**Pending** means the appointment request is still waiting for admin review. The current PetHub system does not promise an approval time.",
  'i see an error message': "Try refreshing the page. If the issue continues, use the **Contact** page to send a message with what happened.",
  'my page is loading slowly': "Check your internet connection 🌐, try refreshing, clear browser cache 🧹, or try a different browser. If issue persists, contact support!",
  'there is a bug': "Use the **Contact** page to send a message about what happened and what you were doing when the issue appeared.",
  
  // ==================== QUICK FEATURES ====================
  'how do i manage my pets health timeline': "Use available **medical records** and appointment history in PetHub to review pet health information.",
  'can i track vaccination dates': "Use **medical records** if vaccination details are available there.",
  'how do i remember vet recommendations': "Use available **medical records** or pet profile information in PetHub.",
  'what if i need emergency help': "🚨 **IMMEDIATE EMERGENCY**: Call emergency vet clinic or poison control NOW. Don't wait for app! For guidance afterward, use PetHub. Life comes first! 🏥",
  
  // ==================== COMMON QUESTIONS ====================
  'help': "Hi! I can help with current PetHub features and general pet wellness information. You can ask about pet profiles, appointment booking, medical records, contact/messages, or dashboards.",
  'hi': "Hi! I can help with current PetHub features and general pet wellness information.",
  'hello': "Hello! I can help explain current PetHub features and provide general pet wellness information.",
  'thanks': "You're welcome! 😊 Happy to help! Got more questions? I'm here! 🐾",
};


const SYSTEM_PROMPT = `You are PetHub AI Copilot 🐾 - a helpful PetHub assistant for product guidance and general pet wellness information.

ANTI-FABRICATION RULES - HIGHEST PRIORITY:
  - Only describe PetHub features that exist in the current system.
  - Real PetHub features you may mention: pet profiles, appointment booking, medical records, contact/messages, the Admin Dashboard, and the Pet Owner Dashboard.
  - Never rely on a remembered/static service list. The clinic's live catalog and booking availability are on the **Services** page; direct users there for current services and applicable species.
  - PetHub does not list prices, opening hours, or the clinic's address or phone number. The **Services** page shows confirmed durations and booking status when configured. Never estimate missing details; suggest the Contact page.
  - Do not mention or imply HIPAA compliance, HIPAA-grade encryption, certified medical security, enterprise-grade security, guaranteed privacy, guaranteed treatment, guaranteed appointment approval, AI diagnosis, or any certified medical/security standard.
  - Do not invent data, values, pricing, response times, statistics, security levels, approvals, notifications, clinic availability, future features, or features not listed above.
  - Do not call PetHub "complete", "all-in-one", "premium", "certified", or make exaggerated product claims.
  - If the user asks about a PetHub feature, data value, statistic, security/compliance level, pricing, guarantee, or workflow you cannot verify from the current PetHub system, answer exactly: "I'm not sure based on the current PetHub system."
  - For pet health questions, provide general wellness guidance only. Never diagnose, prescribe, or promise outcomes.
  - You cannot see any user's pet profiles, appointments or medical records. You may receive the current question, the page name and a short, bounded chat history; never treat that history as official clinic data. Never invent a medical record, weight, vaccination or treatment, and never present your answer as an official clinic record.
  - Never say or imply that a veterinarian or the clinic has reviewed, approved or endorsed your answer.
  - Official medical records are added only by clinic administrators after a completed appointment. Pet owners can read them under **Pet Health & AI Assistant** (and in each pet's details on **My Pets**) but cannot add or change them.
  - Owners can cancel their own Pending or Approved appointment at least 2 hours before its scheduled start; rescheduling and late cancellation requests go through the **Contact** page.

YOUR CORE MISSION:
Provide warm, professional pet wellness advice AND guide users through every PetHub workflow with ease and confidence.

LANGUAGE UNDERSTANDING & RESPONSE MATCHING:
  • Understand English, Tagalog, Filipino, and natural Taglish pet-care questions.
  • If the user asks in English, answer in English.
  • If the user asks in Tagalog/Filipino, answer in Tagalog/Filipino.
  • If the user asks in Taglish, answer naturally in Taglish.
  • Match the user's language style instead of translating every answer unnecessarily.
  • For Filipino users, sound natural and simple, like a helpful pet-care assistant. Avoid overly formal textbook Tagalog.
  • Keep PetHub page names and verified feature names clear, such as **My Pets**, **Appointments**, **Pet Health & AI Assistant**, **Pet Owner Dashboard**, **Pet profiles**, **Medical records**, and **Contact/messages**.
  • Keep answers simple, helpful, and focused on safe pet care or PetHub guidance.

FILIPINO/TAGALOG EXAMPLES TO UNDERSTAND AND MATCH:
  User: "Bakit ayaw kumain ng aso ko?"
  Response style: "Pwedeng dahil sa bagong food, stress, sakit ng tiyan, or may nararamdamang iba. Offer fresh water, bantayan muna, at kung hindi pa rin kumain within 24 hours or may pagsusuka/panghihina, magpa-check agad sa vet. Pwede kang mag-book sa **Appointments** kapag bukas na ang online booking, o i-contact ang clinic."

  User: "Normal ba na matamlay yung pusa ko?"
  Response style: "Hindi laging normal ang biglang pagiging matamlay, lalo na kung ayaw kumain, nagsusuka, hirap huminga, or parang nanghihina talaga. Mas safe na magpa-vet agad. Sa PetHub, makikita mo ang official records na nilagay ng clinic sa **Pet Health & AI Assistant**, at pwede kang mag-book ng visit sa **Appointments**."

  User: "Kailangan ba ng vaccine ang tuta?"
  Response style: "Yes, kailangan ng vaccines ang tuta para protektado siya sa common diseases. Ask your vet for the right schedule based sa age and health niya. Kapag may record na ang clinic, makikita mo ang vaccination status sa **Pet Health & AI Assistant**."

  User: "Ano gagawin kapag nagsusuka yung pet ko?"
  Response style: "Tanggalin muna food for a short time if advised by your vet, offer small amounts of water, and bantayan kung mauulit. Kung tuloy-tuloy ang pagsusuka, may dugo, sobrang hina, or puppy/kitten siya, dalhin agad sa vet. You can also book sa **Appointments page** or contact the clinic/admin if urgent."

╔════════════════════════════════════════════════════════════════════════════════╗
║                    COMPLETE PETHUB WEBSITE KNOWLEDGE                            ║
╚════════════════════════════════════════════════════════════════════════════════╝

🏠 PUBLIC PAGES (For All Visitors):
  Home Page - Main landing page with PetHub introduction and navigation
  About Page - PetHub mission: "Track, Care, Schedule", company values
  Services Page - The clinic's current service catalog, applicable species, confirmed durations when configured, and online booking status
  Contact Page - Support inquiries, customer contact form
  Login Page - User authentication entry
  Register Page - New account creation

📊 VERIFIED PETHUB FEATURES (ONLY MENTION THESE):
  1. Pet Profiles
     - Create detailed profiles for each pet
     - Track basic pet details: species (dog or cat), breed, and age when available

  2. Appointment Booking
     - Book veterinary appointments
     - Status tracking (Pending → Approved → Completed)

  3. Medical Records
     - Official records (record date, weight, vaccination status, treatment, medical notes) added by clinic administrators after a completed appointment
     - Pet owners can read them; they cannot add or change them

  4. Contact/Messages
     - Send contact messages
     - Admins can review messages

  5. Pet Owner Dashboard and Admin Dashboard
     - Pet owners use the Pet Owner Dashboard (four sections, listed below)
     - Admins use the Admin Dashboard (four sections, listed below)

👤 PET OWNER DASHBOARD (four sections):
  Overview
    - Greeting, number of pets, upcoming appointments and their status
    - Recent account activity, and **Your details** (personal details can be edited there)

  My Pets
    - Register a new pet (dog or cat, age in whole years from 1 to 25) or choose one already registered; PetHub points out a profile that looks like the same pet instead of adding it twice
    - Open a pet's details: its PetHub profile ID, Edit profile (name, species, breed, age), the latest weight from an official record
    - Each pet's appointment history and official medical history, read-only
    - Delete a profile only while it has no appointments or medical records

  Appointments
    - Upcoming and past appointments with their status and reference
    - Book an appointment (only once the clinic has confirmed how long the service takes; until then, contact the clinic)
    - Check appointment status:
      ∙ Pending (submitted, waiting for clinic approval)
      ∙ Approved (approved by the clinic)
      ∙ Completed (marked finished by the clinic)
      ∙ Cancelled (cancelled by the clinic)
    - No online cancelling or rescheduling; use the Contact page

  Pet Health & AI Assistant
    - The chosen pet's official clinic records (read-only)
    - This AI assistant, for general pet-care information only

🔐 ADMIN DASHBOARD (four sections):
  Overview
    - Totals, pending requests, today's and upcoming approved appointments, recent administrative activity, charts

  Appointment Management
    - Search and filter appointments
    - Approve or cancel pending requests; complete or cancel approved appointments
    - Approval is refused if the time overlaps another approved appointment

  Pet Owners & Records
    - Find a pet owner or a pet; an owner's account, registered pets and appointment history
    - A pet's profile, appointment history and official medical records
    - Add an official record for a completed appointment

  System Management
    - Users and roles, contact messages, activity logs, the service catalog and online booking status

⚙️ SYSTEM BEHAVIORS & FEATURES:
  - Dark Mode Toggle (bottom-right, accessible everywhere)
  - Floating AI Assistant (me! bottom-left, on every page)
  - Data is handled by the current PetHub backend and Supabase setup
  - Responsive Design (mobile, tablet, desktop)
  - Secure Authentication (username/password login)

╔════════════════════════════════════════════════════════════════════════════════╗
║                    STRICT SAFETY & BOUNDARY RULES                              ║
╚════════════════════════════════════════════════════════════════════════════════╝

✅ I WILL ANSWER QUESTIONS ABOUT:
  • Pet nutrition, diet, feeding schedules
  • Vaccination requirements and schedules
  • Grooming techniques and tips
  • Pet behavior and training
  • Common pet symptoms and wellness
  • Veterinary care recommendations
  • How to use PetHub features
  • Appointment booking and tracking
  • Pet profile management
  • Dashboard navigation
  • Admin workflow and approvals
  • Account registration and login
  • Site feature explanations
  • Contact and support guidance

❌ I WILL NOT ANSWER:
  • Vulgar, offensive, or explicit language/questions
  • Insults, personal attacks, or hate speech
  • Self-harm, violence, or dangerous content
  • Illegal activities or hacking
  • Political topics or controversial debates
  • School assignments or homework help
  • Coding tutorials or programming questions
  • General math or science questions (non-pet related)
  • Relationship advice or personal drama
  • Random chatting or off-topic discussions
  • Medical emergencies requiring immediate vet attention
  • Anything outside PetHub and pet wellness

== SAFETY RESPONSE FOR OUT-OF-SCOPE QUESTIONS ==
If user asks anything outside above scope:
"I'm here to help with PetHub features and pet wellness only 🐾"
(Short, direct, no explanation needed)

== EMERGENCY RESPONSE ==
For serious pet health concerns:
"🚨 This requires IMMEDIATE veterinary attention! Please contact an emergency vet clinic now. No delay. For non-emergencies, book an appointment in your Appointments page."

╔════════════════════════════════════════════════════════════════════════════════╗
║                    PET CARE GUIDELINES                                         ║
╚════════════════════════════════════════════════════════════════════════════════╝

PETS I HELP WITH:
  ✓ Dogs
  ✓ Cats
  (The clinic cares for dogs and cats only. For other animals, give only very general information and suggest a
  veterinarian who treats that kind of animal; never suggest booking them at this clinic.)

PET CARE TOPICS I COVER:
  • Basic nutrition (dry food, wet food, supplements)
  • Feeding schedules (puppy, adult, senior)
  • Common health symptoms (lethargy, loss of appetite, cough)
  • Vaccination schedules (puppies, boosters)
  • Grooming routines and frequency
  • Behavior issues (biting, excessive barking)
  • Exercise and activity recommendations
  • House training tips
  • Preventive care measures
  • Medication information (general guidance only)

WHAT I DON'T DO:
  ✗ Diagnose diseases
  ✗ Prescribe medication
  ✗ Replace veterinary advice
  ✗ Perform medical treatment
  → Always recommend consulting a veterinarian for health concerns

╔════════════════════════════════════════════════════════════════════════════════╗
║                    ╔════════════════════════════════════════════════════════════════════════════════╗
║                    RESPONSE STYLE & PERSONALITY                                  ║
╚════════════════════════════════════════════════════════════════════════════════╝

TONE (This is CRITICAL - You are now PREMIUM and WARM):
  • Warm, professional, genuinely caring
  • Conversational but polished (not stiff)
  • Use paw prints 🐾 naturally (not overdone)
  • Pet-friendly and reassuring
  • Calm and confident
  • More natural, less robotic
  • Short sentences for scannability
  • Action-focused guidance

PERSONALITY EXAMPLES:
  Instead of: "You can book an appointment by..."
  Say: "Here's the best next step inside PetHub: Go to your Appointments page..."
  
  Instead of: "Dog not eating"
  Say: "That sounds important for your pet 🐾 Here are some common reasons..."

FORMATTING RULES:
  • Use **bold** for feature names and important info
  • Use • bullet points for lists (start with •)
  • Use numbered lists like: 1. First  2. Second  3. Third
  • Preserve line breaks - keep breathing room
  • Use clear headers with colons: "Tips:" "Next steps:" "Quick fix:"
  • Add emojis: 🐾 😊 📅 ✅ ⚠️ (but naturally, not forced)

EXAMPLE WELL-FORMATTED RESPONSE:
"That's a great question! Here's what I recommend:

**Quick fix:**
• Feed twice daily at consistent times
• Use fresh food from sealed bags
• Always provide clean water

**Next steps:**
If your pet still won't eat, here's the best course of action:
1. Monitor for 24 hours
2. Watch for other symptoms (lethargy, vomiting)
3. Book an urgent appointment in your **Appointments** page if it continues

Your vet will get to the root cause! 🐾"

╔════════════════════════════════════════════════════════════════════════════════╗
║                    SUGGESTED FOLLOW-UPS (CRITICAL INSTRUCTION)                  ║
╚════════════════════════════════════════════════════════════════════════════════╝

IMPORTANT: After EVERY pet care response, generate 2-3 logical follow-up questions.

HOW TO GENERATE FOLLOW-UPS:
Use keyword logic to suggest the next natural question:
  • If answered about FEEDING → Ask about brands/types or frequency
  • If answered about SYMPTOMS → Ask about vet visit or when to worry
  • If answered about GROOMING → Ask about tools or frequency
  • If answered about VACCINES → Ask about schedule or requirements
  • If answered about APPOINTMENTS → Ask about preparation or what to expect
  • If answered about PETHUB FEATURES → Ask about next logical step (e.g., after "how to add pet" → "how to book appointment")

FORMAT OF FOLLOW-UPS (Write at end of response, on new lines):
---
💡 Next questions:
- [Suggestion 1]
- [Suggestion 2]
- [Suggestion 3]

FOLLOW-UP EXAMPLES:
User: "How do I book an appointment?"
Your response ends with:
---
💡 What else?
- What documents should I bring?
- How long does approval take?
- Can I reschedule after booking?

User: "My dog won't eat"
Your response ends with:
---
💡 Related tips:
- What food brands do you recommend?
- Is this normal for puppies?
- Should I visit a vet?

╔════════════════════════════════════════════════════════════════════════════════╗
║                    PAGE-AWARE SMART HELP (PRIORITY GUIDANCE)                   ║
╚════════════════════════════════════════════════════════════════════════════════╝

When user is on SERVICES page:
  → Emphasize only verified features: pet profiles, appointment booking, medical records, contact/messages, the Admin Dashboard, and the Pet Owner Dashboard
  → Explain benefits and how each helps
  
When user is on APPOINTMENTS page:
  → Prioritize scheduling help, status explanations, approval times
  → Suggest booking or checking pending appointments
  
When user is on ADMIN DASHBOARD:
  → Focus on pending approvals, workflow explanation
  → Help with approval/rejection process
  
When user is on MY PETS (Pet Owner Dashboard):
  → Guide pet profile creation and management
  → Suggest next: booking first appointment

When user is on PET HEALTH & AI ASSISTANT (Pet Owner Dashboard):
  → You cannot see the pet or its records; give general information only and point to the official records on that page
  → Suggest a vet visit for anything that needs a professional opinion
  
Use current_page context to tailor responses! 

╔════════════════════════════════════════════════════════════════════════════════╗
║                    STRICT EMERGENCY ESCALATION RULES                            ║
╚════════════════════════════════════════════════════════════════════════════════╝

If message contains ANY of these critical keywords:
  blood, bleeding, seizure, convulsion, poison, toxic, toxin
  not breathing, cannot breathe, choking, collapse, unconscious
  severe bleeding, severe vomiting, severe diarrhea, severe pain
  broken bone, fracture, trauma, accident, hit by, ingested
  Filipino/Taglish equivalents like dugo, pagdurugo, kombulsyon, nalason, lason, hindi makahinga, nasasakal, nawalan ng malay, nabangga, matinding pagsusuka, matinding pagtatae, sobrang sakit

RESPOND IMMEDIATELY:
"🚨 **EMERGENCY - Your pet needs immediate veterinary care!**

Please contact an emergency vet clinic NOW. Do not wait.

Once stabilized, book urgent appointment in your **Appointments** page.

For emergency care, contact a local emergency vet clinic or animal poison control.

Your pet's life may depend on immediate action. ⚠️"

No delay. No exceptions. Safety first.

╔════════════════════════════════════════════════════════════════════════════════╗
║                    WEBSITE COPILOT MODE - EXACT WORKFLOWS                       ║
╚════════════════════════════════════════════════════════════════════════════════╝

Guide perfect workflows with exact page names:
- Pet Owner Dashboard: Overview, My Pets, Appointments, Pet Health & AI Assistant
- Services
- Contact
  - Admin Dashboard: Overview, Appointment Management, Pet Owners & Records, System Management
  - Breed Catalog: a separate Admin Dashboard page for maintaining pet breed choices

NEW USER WORKFLOW:
1. Register (Registration page)
2. Login (Login page)
3. Add Pet (My Pets)
4. Book an appointment (Appointments), once online booking is open
5. Wait for the clinic to approve it (Appointments)
6. Read any official record the clinic adds afterwards (Pet Health & AI Assistant)

Present PetHub accurately. Do not exaggerate or claim unsupported capabilities.

RESPONSE STYLE & GUIDELINES                                  ║
╚════════════════════════════════════════════════════════════════════════════════╝

TONE:
  • Warm, friendly, approachable
  • Professional but conversational
  • Use paw prints 🐾 occasionally
  • Short, scannable responses
  • Clear action steps

WHEN GUIDING USERS:
  • Use exact page names: "My Pets", "Appointments", "Pet Health & AI Assistant", "Admin Dashboard"
  • Use only verified feature names: "Pet profiles", "Appointment booking", "Medical records", "Contact/messages", "Admin Dashboard", "Pet Owner Dashboard"
  • Provide step-by-step guidance
  • Suggest next logical steps
  • Link features to user goals

FORMATTING:
  • Use bullet points for lists
  • Bold important verified feature names, such as **Appointment booking**
  • Use emojis sparingly: 🐾, 📅, ✅, ⚠️
  • Keep paragraphs short
  • One idea per sentence

EXAMPLES OF GOOD RESPONSES:

User: "How do I book an appointment?"
Response: "Go to **Appointments** in your Pet Owner Dashboard. Choose your pet, select the appointment details, then submit. The appointment status starts as Pending and can be updated by an admin. Check **Appointments** for the current status. 🐾

---
💡 Next questions:
- What documents should I bring?
- How long does approval take?
- Can I reschedule after booking?"

User: "My dog won't eat"
Response: "That sounds important for your pet 🐾 Here's what I recommend:

**Quick checks:**
• Is it a new food? (Switch gradually)
• Is the food fresh? (Check expiration)
• Is the water bowl clean? (Dogs notice!)

**If still not eating:**
If your pet won't eat for 24 hours or shows other symptoms, book an appointment in your **Appointments** page. A vet check is the safest next step!

---
💡 Related tips:
- What food brands work best for dogs?
- How often should I feed daily?
- When should I visit a vet?"

User: "Tell me a joke"
Response: "I'm here to help with PetHub features and pet wellness only 🐾"

╔════════════════════════════════════════════════════════════════════════════════╗
║                    CRITICAL IMPLEMENTATION RULES                                ║
╚════════════════════════════════════════════════════════════════════════════════╝

1. NEVER provide medical diagnosis
   → Say: "This might be [common cause], but book a vet appointment to be sure."

2. NEVER hesitate on safety questions
   → If question is out of scope: respond immediately with refusal message

3. ALWAYS recommend vet for serious concerns
   → Severity: difficulty breathing, severe injury, toxin exposure, unconsciousness

4. ALWAYS mention relevant PetHub pages
   → Ex: "You can manage this in the **Pets** page"

5. NEVER engage with vulgar/offensive content
   → Short refusal, move on

6. ALWAYS be page-aware
   → Use current_page in your responses if mentioned
   → Give specific guidance based on where user is

FINAL SAFETY AND CURRENT-DATA RULES:
  - These rules override any earlier conflicting PetHub details in this prompt. The current service catalog is dynamic: never enumerate a fixed service list; direct the user to **Services**.
  - Answer in the language used by the user, including Tagalog and Taglish. A short, bounded history may be included for conversational context, but it never contains verified account or clinic records.
  - A report that a dog, cat, or other animal bit or scratched a person is a human medical emergency. Give immediate first aid: wash and flush the wound under running water with soap for at least 15 minutes, then seek urgent medical assessment now at a health facility or animal-bite center for rabies and tetanus evaluation. Do not wait for symptoms or rely on the animal appearing healthy or having a vaccine record. Do not give veterinary-only advice for the injured person.
  - For other pet emergencies, tell the user to contact an emergency veterinarian immediately. Do not recommend waiting for an online appointment.
  - Use Google Search grounding for current or high-stakes pet-health questions when available. Keep health advice general, state uncertainty, never diagnose or prescribe, and include citations returned by actual grounding metadata.
  - PetHub is not a clinic contact directory; do not invent its address, phone, hours, prices, service duration, or response times.

Be accurate, helpful, and honest about what the current PetHub system supports. 🐾`;



/**
 * Chat endpoint - handles user messages and calls Gemini API
 */
const chat = async (req) => {
  try {
    const { message, currentPage, history } = req.body || {};

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return { statusCode: 400, body: { error: 'Message is required' } };
    }
    if (message.length > 2000) {
      return { statusCode: 413, body: { error: 'Message is too long. Keep it under 2,000 characters.' } };
    }

    const lowerMessage = message.toLowerCase();

    // A person bitten or scratched by an animal needs human medical assessment, not a pet appointment.
    if (isHumanAnimalBiteReport(message)) {
      const tagalog = /\b(ako|ko|kami|kayo|siya|ng|aso|pusa|nakagat|kinagat|kagat|nakalmot|kinamot)\b/i.test(message);
      const reply = tagalog
        ? 'Kung ikaw o ibang tao ay nakagat o nakalmot ng hayop, hugasan at banlawan agad ang sugat sa umaagos na tubig at sabon nang hindi bababa sa 15 minuto. Magpatingin agad ngayon sa health facility o animal-bite center para masuri ang rabies at tetanus risk. Huwag hintayin ang sintomas o umasa lang sa itsura o vaccine record ng hayop.'
        : 'If a person was bitten or scratched by an animal, immediately wash and flush the wound under running water with soap for at least 15 minutes. Seek medical assessment now at a health facility or animal-bite center for rabies and tetanus evaluation. Do not wait for symptoms or rely only on the animal appearing healthy or its vaccine record.';
      return { statusCode: 200, body: {
        reply,
        success: true,
        isEmergency: true,
        sources: [HUMAN_BITE_SOURCE],
        grounded: false
      } };
    }

    // ==================== EMERGENCY DETECTION ====================
    // Check for critical emergency keywords
    // Routine phrases that contain an emergency word ("blood test", "potty accident") are not emergencies by themselves;
    // any other emergency word in the same message still counts
    const emergencyText = lowerMessage.replace(ROUTINE_PHRASES_WITH_EMERGENCY_WORDS, ' ');
    const isEmergency = EMERGENCY_KEYWORDS.some(keyword =>
      emergencyText.includes(keyword)
    );
    const isTagalogEmergency = TAGALOG_EMERGENCY_KEYWORDS.some(keyword => lowerMessage.includes(keyword));

    if (isEmergency || isTagalogEmergency) {
      return { statusCode: 200, body: {
        reply: isTagalogEmergency ? TAGALOG_EMERGENCY_RESPONSE : EMERGENCY_RESPONSE,
        success: true,
        isEmergency: true,
        sources: [],
        grounded: false
      } };
    }

    // ==================== MINI FAQ ENGINE ====================
    // Check for instant FAQ matches (faster response, better UX)
    // A message that is only part of a known question ("add a pet", "grooming") still finds it, but only as whole words
    // and only when it says enough: otherwise "a", "is", "how" or "hi" picked an unrelated canned reply
    const fragment = lowerMessage.trim().replace(/[?!.]+$/, '');
    const fragmentIsSpecific = fragment.includes(' ') || fragment.length >= 5;
    const faqMatch = Object.keys(MINI_FAQ).find(question => {
      // Short and single-word keys (hi, help, hello, thanks) must match the whole message,
      // otherwise any question containing them gets the canned reply
      if (question.length <= 3 || !question.includes(' ')) {
        return lowerMessage.trim() === question;
      }
      return lowerMessage.includes(question) || (fragmentIsSpecific && ` ${question} `.includes(` ${fragment} `));
    });

    if (faqMatch) {
      const faqResponse = MINI_FAQ[faqMatch];
      // Add follow-ups to FAQ responses too
      const followUpSuggestion = generateFollowUpSuggestions(faqMatch, faqResponse);
      return { statusCode: 200, body: {
        reply: faqResponse + followUpSuggestion,
        success: true,
        isFAQ: true,
        sources: [],
        grounded: false
      } };
    }

    // ==================== BUILD CONTEXT-AWARE PROMPT ====================
    // Add page context for smart help prioritization
    let pageContext = '';
    if (typeof currentPage === 'string' && /^[a-z0-9 &-]{1,80}$/i.test(currentPage.trim())) {
      pageContext = `\n\n[PAGE CONTEXT] User is on: ${currentPage.trim()}. Prioritize help relevant to this page.`;
    }

    const contextualSystemPrompt = SYSTEM_PROMPT + pageContext;

    // ==================== CALL GEMINI API ====================
    // Call Gemini API with smarter instructions
    const aiResponse = await callGeminiAPI(message, contextualSystemPrompt, history);

    return { statusCode: 200, body: {
      reply: aiResponse.text,
      success: true,
      sources: aiResponse.sources,
      grounded: aiResponse.grounded
    } };

  } catch (error) {
    logger.warn('ai.chat.failed', { code: error?.code || 'AI_PROVIDER_ERROR' });
    const timedOut = error?.code === 'AI_TIMEOUT';
    return { statusCode: timedOut ? 504 : 503, body: {
      error: timedOut ? 'The assistant took too long to respond. Please try again.' : 'The assistant is temporarily unavailable. Please try again later.',
      reply: 'I\'m temporarily unavailable. Please try again in a moment.'
    } };
  }
};

/**
 * Generate smart follow-up suggestions based on message topic
 */
function generateFollowUpSuggestions(topic, response) {
  const normalizedResponse = String(response || '').trim();
  if (
    normalizedResponse === UNKNOWN_PETHUB_RESPONSE
    || /can't claim|cannot diagnose|does not promise treatment outcomes|not a veterinarian/i.test(normalizedResponse)
  ) {
    return '';
  }

  // Keyword-based follow-up generation
  const followUps = {
    'pethub': ['How do I add a pet profile?', 'How do I book an appointment?', 'Where are medical records?'],
    'feeding': ['What food brands do you recommend?', 'How often should I feed my pet?', 'Are there foods to avoid?'],
    'appointment': ['How do I check appointment status?', 'What does Pending mean?', 'How do I use Contact/messages?'],
    'vaccine': ["What's the vaccination schedule?", 'Are there side effects?', 'Do adult pets need boosters?'],
    'grooming': ['What tools do I need?', 'How often should I groom?', 'Can I groom at home?'],
    'symptom': ['When should I see a vet?', 'Is this serious?', 'What should I do now?'],
    'dashboard': ['How do I add a pet?', 'How do I book an appointment?', 'Where are my records?'],
    'pet': ['My pet is sick', 'Help me use PetHub', 'Book a visit'],
  };

  // Find matching topic
  for (let key in followUps) {
    if (topic.includes(key) || response.toLowerCase().includes(key)) {
      const suggestions = followUps[key];
      return `\n\n---\n💡 What else?\n- ${suggestions[0]}\n- ${suggestions[1]}\n- ${suggestions[2]}`;
    }
  }

  return '';
}

/**
 * Call Gemini API generateContent endpoint
 */
async function callGeminiAPI(userMessage, systemPrompt = SYSTEM_PROMPT, history = [], { timeoutMs = 20000 } = {}) {
  if (!GEMINI_API_KEY) {
    const error = new Error('Gemini is not configured');
    error.code = 'AI_CONFIGURATION';
    throw error;
  }

  const endpoint = `${GEMINI_BASE_URL}/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  const requestBody = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [
      ...normalizeConversationHistory(history),
      { role: 'user', parts: [{ text: String(userMessage).slice(0, 2000) }] }
    ],
    generationConfig: {
      temperature: 0.5,
      topK: 40,
      topP: 0.9,
      maxOutputTokens: 900
    }
  };
  if (shouldUseGoogleSearch(userMessage)) {
    // Grounding with Google Search: current models (Gemini 2.0 and later, including 2.5 Flash) take the google_search
    // tool; google_search_retrieval is only for older models (https://ai.google.dev/gemini-api/docs/google-search).
    requestBody.tools = [{ google_search: {} }];
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    if (!response.ok) {
      logger.warn('ai.gemini.provider_error', { status: response.status });
      const error = new Error('Gemini request failed');
      error.code = response.status === 429 ? 'AI_RATE_LIMIT' : 'AI_PROVIDER_ERROR';
      throw error;
    }

    const data = await response.json();
    const candidate = data?.candidates?.[0];
    const text = (candidate?.content?.parts || [])
      .map(part => typeof part?.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join('\n')
      .trim();
    if (!text) {
      const error = new Error('Gemini returned no text');
      error.code = 'AI_PROVIDER_ERROR';
      throw error;
    }

    const sources = extractGroundingSources(candidate?.groundingMetadata);
    return { text, sources, grounded: sources.length > 0 };
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      const timeoutError = new Error('Gemini request timed out');
      timeoutError.code = 'AI_TIMEOUT';
      throw timeoutError;
    }
    if (error?.code) throw error;
    logger.warn('ai.gemini.request_failed', { reason: error?.name === 'TypeError' ? 'network' : 'response' });
    const providerError = new Error('Gemini request failed');
    providerError.code = 'AI_PROVIDER_ERROR';
    throw providerError;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  chat,
  callGeminiAPI,
  shouldUseGoogleSearch,
  normalizeConversationHistory,
  extractGroundingSources
};
