/**
 * AI Chat Controller - Gemini API Integration
 * Uses Google's Gemini 2.5 Flash model for pet care advice
 */

require('dotenv').config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const EMERGENCY_KEYWORDS = [
  'blood', 'bleeding', 'seizure', 'convulsion', 'poison', 'toxic', 'toxin',
  'not breathing', 'cannot breathe', 'choking', 'collapse', 'collapsed', 'unconscious',
  'severe bleeding', 'severe vomiting', 'severe diarrhea', 'severe pain',
  'broken bone', 'fracture', 'trauma', 'accident', 'hit by', 'ingested',
  'extreme lethargy', 'unresponsive', 'passing out', 'fainting'
];

const MINI_FAQ = {
  // ==================== PETHUB BASICS ====================
  'what is pethub': "🐾 **PetHub** is your all-in-one pet health management platform! Track pet profiles, schedule vet appointments, store medical records securely, and get 24/7 AI pet care advice. Everything your pets need in one place!",
  'what does pethub do': "PetHub provides **4 core services**: 1️⃣ **Pet Profile Management** (detailed pet health records), 2️⃣ **Smart Scheduling** (easy vet appointment booking), 3️⃣ **Secure Pet Profiles** (encrypted medical records with HIPAA security), 4️⃣ **AI Pet Assistant** (instant pet care guidance). All integrated seamlessly!",
  'what services does pethub offer': "**4 Core Services**: 📝 **Pet Profile** - comprehensive pet records | 📅 **Smart Scheduling** - appointment booking in seconds | 🔒 **Secure Pet Profiles** - encrypted data protection | 🤖 **AI Pet Assistant** - 24/7 wellness advice. Learn more on the **Services** page!",
  'why should i use pethub': "✅ No more lost vet records | ✅ Easy appointment scheduling | ✅ Medical history always accessible | ✅ AI-powered health insights | ✅ Multi-pet management | ✅ Enterprise-grade security | ✅ Completely free!",
  'is pethub free': "Yes! 🎉 PetHub is completely free to use. Create unlimited pet profiles, schedule unlimited appointments, and access AI assistance anytime. No hidden fees!",
  'what makes pethub different': "Other platforms focus on ONE thing. PetHub integrates **profiles + scheduling + security + AI** seamlessly. One dashboard, complete pet wellness. It's pet health management done RIGHT.",
  
  // ==================== GETTING STARTED ====================
  'how do i sign up': "Super easy! 📝 Visit **Register**, enter your full name, email, and password (6+ characters), then click Register. You'll be redirected to login. Log in and you're in your Dashboard instantly! 🎉",
  'how do i login': "Go to **Login**, enter your registered email and password, click Login. You'll land on your personalized **Dashboard** with all your pets and appointments! 🔐",
  'how do i logout': "Click **Logout** in the top-right navigation bar. You'll be safely logged out and returned to the homepage. Simple!",
  'what happens after i sign up': "After registration: 1️⃣ Verify email if needed 2️⃣ Log in 3️⃣ Land on Dashboard 4️⃣ Click **Pets** to add your first pet 5️⃣ Click **Appointments** to book a vet visit 6️⃣ Start managing! 🚀",
  'can i have multiple accounts': "We recommend one account per person. Use that one account to manage all your pets! If needed, create a new email and sign up separately.",
  'is my account secure': "Yes! 🔒 Your account is protected with encrypted passwords, secure sessions, and HIPAA-grade data protection. Your data never leaves our secure servers.",
  
  // ==================== PET MANAGEMENT ====================
  'how do i add a pet': "Go to **Pets** page → Click **Add New Pet** form → Enter: Name, Species (Dog/Cat/Bird/Rabbit/Other), Breed, Age (optional) → Click **Add Pet**. Done! 🎉",
  'what info should i add for my pet': "**Required**: Pet name, species. **Optional but helpful**: Breed, age. You can also add: medical history, allergies, vaccinations, behavioral notes, special needs. More = better care! 📋",
  'can i add multiple pets': "Absolutely! Add as many as you want. Each pet gets its own profile, medical records, and appointment schedule. Perfect for households with multiple pets! 🐕🐈🦜",
  'how do i edit a pets profile': "Go **Pets** page → Find your pet → (Edit button appears) → Update name/breed/age/details → Click Save. Changes are instant! ⚡",
  'how do i delete a pet': "Go **Pets** page → Find your pet → Click delete button (trash icon) → confirm. Note: This removes the pet from active profiles but keeps history for records.",
  'what if i add my pet by wrong name': "No problem! Go to **Pets**, find the pet, click edit, correct the name, and save. You can update any information anytime! 🔄",
  'the species options are limited': "We support: 🐕 Dog, 🐈 Cat, 🦜 Bird, 🐰 Rabbit, 🐾 Other (for exotic pets, fish, reptiles, etc). If you need a specific type under 'Other', note it in your pet profile!",
  'how do i track my pets health': "Add details in the pet profile (vaccines, medical history, notes), use **Appointment** records as health timeline, and reference the AI assistant for specific health concerns! 📊",
  'can i share pet profiles with my vet': "Not directly in the app, but you can screenshot or share appointment confirmations. Your vet can access info during scheduled appointments! 📧",
  
  // ==================== APPOINTMENTS ====================
  'how do i book an appointment': "Go **Appointments** → Fill form: Pet Name, Service Type, Date, Time → Click **Book** → Status shows **Pending** → Vet reviews within 24h → Approval notification! 📅",
  'what appointment services are available': "✓ **Checkup** (general wellness), 💉 **Vaccination** (boosters, required shots), ✄ **Grooming** (professional care), 🦷 **Dental** (teeth cleaning), 🔧 **Surgery** (if needed), 📋 **Other** (custom services)",
  'what does pending mean': "**Pending** = Your appointment request is submitted and waiting for vet approval. ⏳ Usually takes **24 hours or less**. Check your Appointments page for updates!",
  'what does approved mean': "**Approved** = The vet confirmed your appointment! ✅ Date/time is locked in. Arrive a few minutes early. Check your dashboard for location/time details!",
  'what does completed mean': "**Completed** = Your appointment finished successfully! 🎉 It stays in your history for future reference. Great for tracking vaccination dates, health progression!",
  'what does cancelled mean': "**Cancelled** = The vet rejected the appointment or you cancelled it. ❌ No problem! Book a new one with different date/time. ♻️",
  'how long does approval take': "Most appointments are approved **within 24 hours**. If it's been longer, contact support via the **Contact** page. Vet might need more info!",
  'can i cancel an appointment': "If **Pending**: Yes, book a new one anytime. If **Approved**: Contact support or the vet first to cancel as a courtesy. ✅",
  'can i reschedule after approval': "Cancel current and book a new one with preferred date/time! Super easy. We recommend doing this ASAP if the vet has availability. 📅",
  'what if i miss an appointment': "Contact your vet immediately! They may charge no-show fees. Then reschedule in PetHub. Better communication = better care! 📞",
  'can i book multiple appointments': "Yes! Book as many as needed for all your pets. Each has its own timeline and status tracking. Manage everything from one dashboard! 📊",
  'what time should i book appointments': "Check your vet's hours and availability! Choose a time that works for you AND the vet. Book during their business hours for faster approval. ⏰",
  
  // ==================== DASHBOARD & FEATURES ====================
  'what is my dashboard': "Your personal **command center**! 📊 See an overview of: Total pets, Upcoming appointments, Account status, Recent pets (quick add links), Recent appointments. Everything at a glance!",
  'what can i see on the dashboard': "✓ Pet count, ✓ Appointment count, ✓ Account status (Active), ✓ Quick links to Pets/Appointments pages, ✓ Recent pet updates, ✓ Upcoming appointment summary",
  'how do i navigate pethub': "Top navigation bar has everything: 🏠 **Home** | 👤 **Dashboard** | 🐾 **Pets** | 📅 **Appointments** | ℹ️ **About** | 🎯 **Services** | 📧 **Contact** | 🚪 **Logout** + 🌙 dark mode toggle",
  'where is the dark mode toggle': "Bottom-right corner of any page! 🌙 Click to switch between light and dark modes. Your preference saves automatically! 🌗",
  'what is the home page': "Landing page with PetHub intro, features overview, and Call-to-Action buttons to Register or Login. Great place to learn about PetHub before creating an account! 🏠",
  'what is the about page': "Learn PetHub's mission, values, and team story. We're dedicated to pet wellness and making pet health management **simple, secure, and smart**! 💙",
  'what is the services page': "Deep dive into our 4 core services with detailed explanations: Pet Profile, Smart Scheduling, Secure Pet Profiles, and AI Pet Assistant. Perfect for understanding what you get! 🎯",
  'what is the contact page': "Send us messages, ask questions, report issues, or request features! 📧 Also shows contact info: email, phone, hours. We respond within 24 hours!",
  
  // ==================== SECURITY & PRIVACY ====================
  'is my pet data secure': "Yes! 🔒 **HIPAA-grade encryption** via Supabase, secure servers, encrypted at rest and in transit. Your pet's medical records are protected like real hospital records!",
  'what security does pethub have': "✓ Encrypted passwords | ✓ HTTPS connections | ✓ Secure database (Supabase) | ✓ HIPAA compliance | ✓ No third-party sharing | ✓ Enterprise-grade protection",
  'what data does pethub collect': "Only what you provide: name, email, pet details, vaccination/health records. We NEVER collect location, device ID, browsing history, or sell data to third parties! 🛡️",
  'can vets see my pet records': "Only during appointments or if you explicitly share info. Your medical records belong to YOU. Vets cannot access unless authorized!",
  'does pethub share my data': "No! 🔒 We never sell, share, or export your data. Your pet's medical information is yours alone. Full privacy guaranteed!",
  'is my password stored safely': "Ultra-safe! 🔐 Passwords are cryptographically hashed using modern standards. We never store plain-text passwords. Unhackable!",
  
  // ==================== AI ASSISTANT ====================
  'who are you': "I'm **PetHub AI Copilot**! 🤖 A 24/7 pet wellness assistant built specifically for PetHub. I can help with pet care advice, guide you through PetHub features, answer wellness questions, and more! Ask me anything!",
  'what can you help me with': "I can help with: 🐾 Pet wellness advice | 🏥 Health guidance | 🐕 Behavior & training tips | 🥘 Nutrition info | 🎓 PetHub feature walkthroughs | 📞 General pet questions | 🚨 Emergency guidance",
  'are you available 24/7': "Yes! I'm available anytime, anywhere. 🌍 Pop up this chat bubble to ask questions at any time. Day, night, weekend, holidays — I'm here!",
  'can you replace my vet': "No way! I'm an **informational assistant**, not a veterinarian. 🏥 For medical emergencies, go to an emergency vet immediately! Use me for wellness guidance before/after vet visits!",
  'what if i have an emergency': "Contact your nearest **emergency vet clinic immediately**! 🚨 I can provide guidance, but NOTHING replaces professional medical care for emergencies. Call 911 or poison control if needed!",
  'how accurate is your advice': "Very accurate for wellness information! 📚 But I'm not a vet — just an informed assistant. Always verify important health decisions with your veterinarian! ✅",
  'can you diagnose my pet': "No, but I can help you understand symptoms and recommend when to call your vet! 🏥 Diagnosis requires professional examination. I guide you TO the vet! 🎯",
  
  // ==================== ADMIN FEATURES (if user asks) ====================
  'what can admins do': "Admins have special powers: 🔍 View all pending appointments, ✅ Approve/reject appointment requests, 👥 Manage user accounts, 🐾 View all pet records, 📊 Generate reports, 🔐 System management",
  'how do appointments get approved': "Admin Dashboard shows all Pending appointments. Admins review pet/vet/time info, check availability, then: ✅ Approve (schedule confirmed) or ❌ Reject (reschedule needed). User notified instantly!",
  'what is the admin dashboard': "Special admin-only interface to: oversee all appointments, approve requests, manage users, view system metrics, generate reports. It's the backend nerve center! 🎛️",
  
  // ==================== TROUBLESHOOTING ====================
  'i forgot my password': "Visit **Login** page → Look for 'Forgot Password' link → Follow reset instructions via email. Can't find it? Contact support on **Contact** page! 🔄",
  'my appointment is not showing': "Try refreshing page or logging out/back in! 🔄 If still missing: Check if it's **Cancelled** status, verify you entered correct pet name, or contact support!",
  'why is my appointment still pending': "Vet is reviewing! Usually 24h or less. ⏳ If longer: Contact support or call the vet directly. They might need additional info! 📞",
  'i see an error message': "Take a screenshot! 📸 Then: 1) Try refreshing the page, 2) Clear browser cache, 3) Try different browser, 4) Contact support with screenshot. We'll fix it! 🛠️",
  'my page is loading slowly': "Check your internet connection 🌐, try refreshing, clear browser cache 🧹, or try a different browser. If issue persists, contact support!",
  'there is a bug': "Found a bug? 🐛 Contact support on the **Contact** page with: what you were doing, what happened, browser type, screenshots. We'll fix it ASAP! 🚀",
  
  // ==================== QUICK FEATURES ====================
  'how do i manage my pets health timeline': "Use your Appointments page! 📅 Every completed appointment is timestamped and recorded. Vaccination dates, checkup history, all tracked automatically!",
  'can i track vaccination dates': "Yes! 💉 Add vaccination details in pet profile. Future: appointments system tracks dates automatically. Your complete vaccination timeline in one place!",
  'how do i remember vet recommendations': "Add to pet profile notes! 📝 You can also screenshot Approved appointment confirmations. Reference them anytime with PetHub! 📸",
  'what if i need emergency help': "🚨 **IMMEDIATE EMERGENCY**: Call emergency vet clinic or poison control NOW. Don't wait for app! For guidance afterward, use PetHub. Life comes first! 🏥",
  
  // ==================== COMMON QUESTIONS ====================
  'help': "Hi! 👋 I'm PetHub AI! Need help? You can ask me: ❓ Questions about using PetHub | 🐾 Pet wellness advice | 🏥 Health guidance | 🚀 How to get started | 🐕 General pet questions. What do you need?",
  'hi': "Hey there! 👋 Welcome to PetHub AI! I'm here 24/7 to help. What would you like to know about managing your pets or using PetHub? 🐾",
  'hello': "Hello! 👋 I'm PetHub's AI assistant. Ready to help! Ask me anything about pets, PetHub features, or wellness guidance! 🤖",
  'thanks': "You're welcome! 😊 Happy to help! Got more questions? I'm here! 🐾",
};


const SYSTEM_PROMPT = `You are PetHub AI Copilot 🐾 — Premium pet care assistant built just for PetHub.

YOUR CORE MISSION:
Provide warm, professional pet wellness advice AND guide users through every PetHub workflow with ease and confidence.

╔════════════════════════════════════════════════════════════════════════════════╗
║                    COMPLETE PETHUB WEBSITE KNOWLEDGE                            ║
╚════════════════════════════════════════════════════════════════════════════════╝

🏠 PUBLIC PAGES (For All Visitors):
  Home Page - Main landing page, features overview, get started CTA
  About Page - PetHub mission: "Track, Care, Schedule", company values
  Services Page - 4 core features: Pet Profile, Smart Scheduling, Secure Pet Profiles, AI Pet Assistant
  Contact Page - Support inquiries, customer contact form
  Login Page - User authentication entry
  Register Page - New account creation

📊 CORE FEATURES (The Foundation):
  1. Pet Profile Management
     - Create detailed profiles for each pet
     - Track species, breed, age, medical history
     - Store vaccination records
     - Monitor health timeline

  2. Smart Scheduling
     - Book veterinary appointments
     - Real-time availability checking
     - Appointment confirmation system
     - Status tracking (Pending → Approved → Completed)

  3. Secure Pet Profiles
     - HIPAA-grade security
     - Cloud-based data storage via Supabase
     - Encrypted medical records
     - Reliable data protection
     - Never lose pet health history

  4. AI Pet Assistant
     - Instant pet care guidance
     - Nutrition recommendations
     - Grooming & behavior advice
     - Symptom recognition
     - General wellness tips
     - (That's me! 🤖)

👤 USER DASHBOARD ECOSYSTEM:
  Dashboard Page
    - Quick overview of all pets
    - Upcoming appointments summary
    - Health alerts
    - Activity timeline

  Pets Page
    - Manage all pet profiles
    - Add new pets
    - Edit pet information
    - View medical history
    - Track vaccination status
    - Upload health documents

  Appointments Page
    - Book new appointments
    - View all scheduled appointments
    - Check appointment status:
      ∙ Pending (submitted, waiting for vet approval)
      ∙ Approved (confirmed, ready)
      ∙ Completed (finished successfully)
      ∙ Cancelled (rejected or user cancelled)
    - Upcoming appointment reminders
    - Appointment history

🔐 ADMIN DASHBOARD WORKFLOW:
  Admin Dashboard
    - Overview of pending tasks
    - System statistics
    - Performance analytics

  Admin Appointments
    - View all user appointment requests
    - Approve appointments (mark as Approved)
    - Reject appointments (mark as Cancelled)
    - Update appointment status
    - Track completed appointments

  Admin Pets
    - Monitor all user pet profiles
    - Health record verification
    - Pet population statistics

  Admin Users
    - View registered users
    - User activity tracking
    - Account management

⚙️ SYSTEM BEHAVIORS & FEATURES:
  - Dark Mode Toggle (bottom-right, accessible everywhere)
  - Floating AI Assistant (me! bottom-left, on every page)
  - Real-time Data Sync (all changes saved immediately)
  - Session Persistence (chat resets on page refresh for privacy)
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
  ✓ Rabbits
  ✓ Birds
  ✓ Fish
  ✓ Hamsters
  ✓ Guinea pigs
  ✓ Reptiles
  ✓ Other household pets

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
  → Emphasize the 4 features: Pet Management, Smart Scheduling, Secure Storage, AI Assistant
  → Explain benefits and how each helps
  
When user is on APPOINTMENTS page:
  → Prioritize scheduling help, status explanations, approval times
  → Suggest booking or checking pending appointments
  
When user is on ADMIN DASHBOARD:
  → Focus on pending approvals, workflow explanation
  → Help with approval/rejection process
  
When user is on PETS page:
  → Guide pet profile creation and management
  → Suggest next: booking first appointment
  
Use current_page context to tailor responses! 

╔════════════════════════════════════════════════════════════════════════════════╗
║                    STRICT EMERGENCY ESCALATION RULES                            ║
╚════════════════════════════════════════════════════════════════════════════════╝

If message contains ANY of these critical keywords:
  blood, bleeding, seizure, convulsion, poison, toxic, toxin
  not breathing, cannot breathe, choking, collapse, unconscious
  severe bleeding, severe vomiting, severe diarrhea, severe pain
  broken bone, fracture, trauma, accident, hit by, ingested

RESPOND IMMEDIATELY:
"🚨 **EMERGENCY - Your pet needs immediate veterinary care!**

Please contact an emergency vet clinic NOW. Do not wait.

Once stabilized, book urgent appointment in your **Appointments** page.

For 24/7 emergency care, search '[Your City] Emergency Vet Clinic' or call animal poison control.

Your pet's life may depend on immediate action. ⚠️"

No delay. No exceptions. Safety first.

╔════════════════════════════════════════════════════════════════════════════════╗
║                    WEBSITE COPILOT MODE - EXACT WORKFLOWS                       ║
╚════════════════════════════════════════════════════════════════════════════════╝

Guide perfect workflows with exact page names:
- Dashboard
- Pets
- Appointments
- Services
- Contact
- Admin Dashboard

NEW USER WORKFLOW:
1. Register (Registration page)
2. Login (Login page)
3. Add Pet (Pets page)
4. Schedule Appointment (Appointments page)
5. Wait for Admin approval (Appointments page)
6. Appointment confirmed (Dashboard)

Always present PetHub as the complete solution! This is your website. Be its voice.

RESPONSE STYLE & GUIDELINES                                  ║
╚════════════════════════════════════════════════════════════════════════════════╝

TONE:
  • Warm, friendly, approachable
  • Professional but conversational
  • Use paw prints 🐾 occasionally
  • Short, scannable responses
  • Clear action steps

WHEN GUIDING USERS:
  • Use exact page names: "Pets page", "Appointments page", "Admin Dashboard"
  • Use feature names: "Smart Scheduling", "Secure Pet Profiles"
  • Provide step-by-step guidance
  • Suggest next logical steps
  • Link features to user goals

FORMATTING:
  • Use bullet points for lists
  • Bold important feature names: **Smart Scheduling**
  • Use emojis sparingly: 🐾, 📅, ✅, ⚠️
  • Keep paragraphs short
  • One idea per sentence

EXAMPLES OF GOOD RESPONSES:

User: "How do I book an appointment?"
Response: "Go to your **Appointments** page in your dashboard. Click 'Book Appointment', select your pet, choose a date/time, then submit. The vet will review your request and approve it within 24 hours. You'll see the status change from Pending to Approved once confirmed! 🐾

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

This is YOUR website. Be its voice. Help users love PetHub. 🐾`;



/**
 * Chat endpoint - handles user messages and calls Gemini API
 */
const chat = async (req, res) => {
  try {
    const { message, currentPage } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const lowerMessage = message.toLowerCase();

    // ==================== EMERGENCY DETECTION ====================
    // Check for critical emergency keywords
    const isEmergency = EMERGENCY_KEYWORDS.some(keyword => 
      lowerMessage.includes(keyword)
    );

    if (isEmergency) {
      const emergencyResponse = "🚨 **EMERGENCY - Your pet needs immediate veterinary care!**\n\nPlease contact an emergency vet clinic NOW. Do not wait.\n\nOnce stabilized, book urgent appointment in your **Appointments** page.\n\nFor 24/7 emergency care, search '[Your City] Emergency Vet Clinic' or call animal poison control.\n\nYour pet's life may depend on immediate action. ⚠️";
      return res.json({
        reply: emergencyResponse,
        success: true,
        isEmergency: true
      });
    }

    // ==================== MINI FAQ ENGINE ====================
    // Check for instant FAQ matches (faster response, better UX)
    const faqMatch = Object.keys(MINI_FAQ).find(question => {
      return lowerMessage.includes(question) || question.includes(lowerMessage);
    });

    if (faqMatch) {
      const faqResponse = MINI_FAQ[faqMatch];
      // Add follow-ups to FAQ responses too
      const followUpSuggestion = generateFollowUpSuggestions(faqMatch, faqResponse);
      return res.json({
        reply: faqResponse + followUpSuggestion,
        success: true,
        isFAQ: true
      });
    }

    // ==================== BUILD CONTEXT-AWARE PROMPT ====================
    // Add page context for smart help prioritization
    let pageContext = '';
    if (currentPage) {
      pageContext = `\n\n[PAGE CONTEXT] User is on: ${currentPage}. Prioritize help relevant to this page.`;
    }

    const contextualSystemPrompt = SYSTEM_PROMPT + pageContext;

    // ==================== CALL GEMINI API ====================
    // Call Gemini API with smarter instructions
    const aiResponse = await callGeminiAPI(message, contextualSystemPrompt);

    res.json({
      reply: aiResponse,
      success: true
    });

  } catch (error) {
    console.error('AI Chat error:', error);
    
    // Return user-friendly error message
    if (error.message.includes('API key')) {
      return res.status(500).json({ 
        error: 'AI service configuration error. Please try again later.',
        reply: 'I apologize, but I\'m temporarily unavailable. Please try again in a moment.'
      });
    }

    res.status(500).json({ 
      error: 'Server error processing your message',
      reply: 'I encountered an error processing your request. Please try again.'
    });
  }
};

/**
 * Generate smart follow-up suggestions based on message topic
 */
function generateFollowUpSuggestions(topic, response) {
  // Keyword-based follow-up generation
  const followUps = {
    'feeding': ['What food brands do you recommend?', 'How often should I feed my pet?', 'Are there foods to avoid?'],
    'appointment': ['What should I bring?', 'How long does it take?', 'Can I reschedule?'],
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
async function callGeminiAPI(userMessage, systemPrompt = SYSTEM_PROMPT) {
  const endpoint = `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const requestBody = {
    system_instruction: {
      parts: {
        text: systemPrompt
      }
    },
    contents: {
      parts: [
        {
          text: userMessage
        }
      ]
    },
    generationConfig: {
      temperature: 0.7,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 500
    }
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Gemini API error:', errorData);
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();

    // Extract text from Gemini response
    if (data.candidates && data.candidates.length > 0) {
      const candidate = data.candidates[0];
      if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
        return candidate.content.parts[0].text;
      }
    }

    throw new Error('Invalid response format from Gemini API');

  } catch (error) {
    console.error('Gemini API call failed:', error);
    
    // Return helpful fallback message
    if (error.message.includes('API key')) {
      throw new Error('AI API key configuration error');
    }
    
    throw new Error(`Failed to get AI response: ${error.message}`);
  }
}

module.exports = { chat };
