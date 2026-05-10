/**
 * PetHub AI Widget
 * Global floating chat bubble with Gemini AI integration
 * Isolated in IIFE to prevent conflicts
 */

(() => {
  // ==================== CONSTANTS ====================
  const AI_WIDGET_API = window.API_BASE_URL || "http://localhost:5000";
  const STORAGE_KEY = "pethub_ai_chat";
  const WIDGET_INITIALIZED = "pethub_ai_widget_loaded";
  let aiMessageInProgress = false;

  // ==================== INITIALIZATION ====================
  
  /**
   * Check if widget already loaded
   */
  if (window[WIDGET_INITIALIZED]) {
    return;
  }
  window[WIDGET_INITIALIZED] = true;

  /**
   * Initialize on DOM ready
   */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeAIWidget);
  } else {
    initializeAIWidget();
  }

  // ==================== MAIN INITIALIZATION ====================

  function initializeAIWidget() {
    injectStyles();
    injectHTML();
    setupEventListeners();
    restoreChatSession();
  }

  // ==================== INJECT STYLES ====================

  function injectStyles() {
    const styleId = 'pethub-ai-widget-styles';
    if (document.getElementById(styleId)) return;

    const styles = document.createElement('style');
    styles.id = styleId;
    styles.innerHTML = `
      /* AI Widget Container */
      .pethub-ai-widget {
        position: fixed;
        bottom: 1.25rem;
        left: 1.25rem;
        z-index: 9998;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      }

      /* Floating Button */
      .pethub-ai-button {
        width: 3.5rem;
        height: 3.5rem;
        border-radius: 50%;
        background: linear-gradient(135deg, #FF8C42 0%, #FF7629 100%);
        border: none;
        color: white;
        font-size: 1.5rem;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 12px rgba(255, 140, 66, 0.4);
        transition: transform 0.18s ease, box-shadow 0.18s ease, background-color 0.18s ease;
        z-index: 9999;
      }

      .pethub-ai-button:hover {
        transform: translateY(-1px);
        box-shadow: 0 6px 18px rgba(255, 140, 66, 0.32);
      }

      .pethub-ai-button:active {
        transform: translateY(0);
      }

      /* Chat Popup - REDESIGNED */
      .pethub-ai-popup {
        position: fixed;
        bottom: 6rem;
        left: 1.25rem;
        width: 340px;
        height: 460px;
        background: white;
        border-radius: 1.25rem;
        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.12);
        display: flex;
        flex-direction: column;
        z-index: 9998;
        opacity: 0;
        transform: translateY(8px);
        pointer-events: none;
        transition: opacity 0.18s ease, transform 0.18s ease;
      }

      .pethub-ai-popup.active {
        opacity: 1;
        transform: translateY(0);
        pointer-events: all;
      }

      /* Header - REDESIGNED MINIMAL */
      .pethub-ai-header {
        background: linear-gradient(135deg, #FF8C42 0%, #FF7629 100%);
        color: white;
        padding: 0.75rem 1rem;
        border-radius: 1.25rem 1.25rem 0 0;
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-shrink: 0;
      }

      .pethub-ai-header h3 {
        margin: 0;
        font-size: 1rem;
        font-weight: 600;
        letter-spacing: -0.3px;
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }

      .pethub-ai-header h3::before {
        content: '🤖';
        font-size: 1.1rem;
      }

      .pethub-ai-header-controls {
        display: flex;
        gap: 0.25rem;
      }

      .pethub-ai-header button {
        background: rgba(255, 255, 255, 0.15);
        border: none;
        color: white;
        cursor: pointer;
        width: 1.5rem;
        height: 1.5rem;
        border-radius: 0.375rem;
        font-size: 0.9rem;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
      }

      .pethub-ai-header button:hover {
        background: rgba(255, 255, 255, 0.25);
        transform: translateY(-1px);
      }

      .pethub-ai-header button:active {
        transform: translateY(0);
      }

      /* Messages Container - BETTER VISIBILITY */
      .pethub-ai-messages {
        flex: 1;
        overflow-y: auto;
        padding: 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        background: white;
      }

      .pethub-ai-messages::-webkit-scrollbar {
        width: 5px;
      }

      .pethub-ai-messages::-webkit-scrollbar-track {
        background: transparent;
      }

      .pethub-ai-messages::-webkit-scrollbar-thumb {
        background: rgba(255, 140, 66, 0.3);
        border-radius: 3px;
      }

      .pethub-ai-messages::-webkit-scrollbar-thumb:hover {
        background: #FF8C42;
      }

      /* Message Bubble - User */
      .pethub-ai-message.user {
        display: flex;
        justify-content: flex-end;
        animation: messageSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      }

      .pethub-ai-message.user .bubble {
        background: linear-gradient(135deg, #FF8C42 0%, #FF7629 100%);
        color: white;
        padding: 0.7rem 1rem;
        border-radius: 1.2rem;
        max-width: 85%;
        word-wrap: break-word;
        font-size: 0.94rem;
        line-height: 1.5;
        box-shadow: 0 2px 8px rgba(255, 140, 66, 0.2);
        transition: transform 0.2s ease;
      }

      .pethub-ai-message.user .bubble:hover {
        transform: translateY(-2px);
      }

      /* Message Bubble - AI */
      .pethub-ai-message.ai {
        display: flex;
        justify-content: flex-start;
        animation: messageSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      }

      .pethub-ai-message.ai .bubble {
        background: #f0f0f0;
        color: #333;
        padding: 0.7rem 1rem;
        border-radius: 1.2rem;
        max-width: 85%;
        word-wrap: break-word;
        font-size: 0.94rem;
        line-height: 1.5;
        border: none;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
        transition: transform 0.2s ease;
      }

      .pethub-ai-message.ai .bubble:hover {
        transform: translateY(-2px);
      }

      /* Loading indicator - SUBTLE TYPING DOTS */
      .pethub-ai-message.ai .bubble.loading {
        display: flex;
        gap: 0.4rem;
        align-items: center;
        padding: 0.6rem 1rem;
      }

      .pethub-ai-message.ai .bubble.loading span {
        width: 0.35rem;
        height: 0.35rem;
        background: #999;
        border-radius: 50%;
        animation: pethub-bounce 1.4s infinite;
        opacity: 0.6;
      }

      .pethub-ai-message.ai .bubble.loading span:nth-child(1) {
        animation-delay: 0s;
      }

      .pethub-ai-message.ai .bubble.loading span:nth-child(2) {
        animation-delay: 0.15s;
      }

      .pethub-ai-message.ai .bubble.loading span:nth-child(3) {
        animation-delay: 0.3s;
      }

      @keyframes messageSlideIn {
        from {
          opacity: 0;
          transform: translateY(8px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      @keyframes pethub-bounce {
        0%, 60%, 100% {
          transform: translateY(0);
          opacity: 0.6;
        }
        30% {
          transform: translateY(-0.4rem);
          opacity: 1;
        }
      }

      @keyframes pethub-ai-spin {
        to {
          transform: rotate(360deg);
        }
      }

      /* Quick Starters - ONLY 3, MINIMAL STYLE */
      .pethub-ai-starters {
        padding: 0.75rem 1rem;
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
        justify-content: flex-start;
        flex-shrink: 0;
        border-top: 1px solid #f0f0f0;
      }

      .pethub-ai-starter-chip {
        background: white;
        border: 1px solid #ddd;
        color: #555;
        border-radius: 2rem;
        padding: 0.4rem 0.9rem;
        font-size: 0.8rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
        white-space: nowrap;
      }

      .pethub-ai-starter-chip:hover {
        border-color: #FF8C42;
        color: #FF8C42;
        background: #fff8f5;
        transform: translateY(-1px);
      }

      .pethub-ai-starter-chip:active {
        transform: translateY(0);
      }

      /* Input Area - REDESIGNED CLEAN */
      .pethub-ai-input-area {
        padding: 0.75rem 1rem;
        border-top: 1px solid #f0f0f0;
        display: flex;
        gap: 0.5rem;
        flex-shrink: 0;
      }

      .pethub-ai-input-area input {
        flex: 1;
        border: 1px solid #ddd;
        border-radius: 0.8rem;
        padding: 0.6rem 1rem;
        font-size: 0.94rem;
        outline: none;
        background: white;
        transition: all 0.2s ease;
      }

      .pethub-ai-input-area input::placeholder {
        color: #999;
      }

      .pethub-ai-input-area input:focus {
        border-color: #FF8C42;
        box-shadow: 0 0 0 2px rgba(255, 140, 66, 0.08);
      }

      .pethub-ai-input-area button {
        background: #FF8C42;
        color: white;
        border: none;
        border-radius: 50%;
        width: 2rem;
        height: 2rem;
        font-size: 1rem;
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }

      .pethub-ai-input-area button:hover {
        background: #FF7629;
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(255, 140, 66, 0.3);
      }

      .pethub-ai-input-area button:active {
        transform: translateY(0);
      }

      .pethub-ai-input-area button:disabled {
        background: #ccc;
        cursor: not-allowed;
        transform: none;
      }

      .pethub-ai-button-spinner {
        width: 0.9rem;
        height: 0.9rem;
        border: 2px solid rgba(255, 255, 255, 0.45);
        border-top-color: #fff;
        border-radius: 999px;
        animation: pethub-ai-spin 0.7s linear infinite;
      }

      /* Footer */
      .pethub-ai-footer {
        padding: 0.5rem 0.75rem;
        border-top: 1px solid #f0f0f0;
        font-size: 0.7rem;
        color: #aaa;
        text-align: center;
        line-height: 1.3;
        flex-shrink: 0;
      }

      /* Mobile Responsive - SAFE & CLEAN */
      @media (max-width: 480px) {
        .pethub-ai-widget {
          bottom: 1rem;
          left: 1rem;
        }

        .pethub-ai-button {
          width: 3rem;
          height: 3rem;
          font-size: 1.25rem;
        }

        .pethub-ai-popup {
          width: 90vw;
          height: 70vh;
          max-height: 550px;
          max-width: 340px;
          bottom: 90px;
          border-radius: 1.25rem;
        }

        .pethub-ai-message.user .bubble,
        .pethub-ai-message.ai .bubble {
          max-width: 85%;
        }
      }

      /* Dark Mode Support - CLEAN */
      @media (prefers-color-scheme: dark) {
        .pethub-ai-popup {
          background: #1e1e1e;
          color: #e0e0e0;
        }

        .pethub-ai-messages {
          background: #1e1e1e;
        }

        .pethub-ai-message.ai .bubble {
          background: #2a2a2a;
          color: #e0e0e0;
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
        }

        .pethub-ai-starters {
          border-top-color: #333;
        }

        .pethub-ai-starter-chip {
          background: #2a2a2a;
          border-color: #333;
          color: #aaa;
        }

        .pethub-ai-starter-chip:hover {
          border-color: #FF8C42;
          color: #FF8C42;
          background: rgba(255, 140, 66, 0.1);
        }

        .pethub-ai-input-area {
          border-top-color: #333;
        }

        .pethub-ai-input-area input {
          background: #2a2a2a;
          color: #e0e0e0;
          border-color: #333;
        }

        .pethub-ai-input-area input:focus {
          border-color: #FF8C42;
          box-shadow: 0 0 0 2px rgba(255, 140, 66, 0.15);
        }

        .pethub-ai-footer {
          color: #666;
          border-top-color: #333;
        }
      }
    `;
    document.head.appendChild(styles);
  }

  // ==================== INJECT HTML ====================

  function injectHTML() {
    const widgetId = 'pethub-ai-widget-container';
    if (document.getElementById(widgetId)) return;

    const widget = document.createElement('div');
    widget.id = widgetId;
    widget.className = 'pethub-ai-widget';
    widget.innerHTML = `
      <!-- Floating Button -->
      <button class="pethub-ai-button" id="pethub-ai-toggle" title="Chat with PetHub AI" aria-label="Open PetHub AI Assistant">
        <i class="ri-robot-line"></i>
      </button>

      <!-- Chat Popup -->
      <div class="pethub-ai-popup" id="pethub-ai-popup">
        <!-- Header -->
        <div class="pethub-ai-header">
          <h3>PetHub AI</h3>
          <div class="pethub-ai-header-controls">
            <button id="pethub-ai-close" title="Close" aria-label="Close chat">
              <i class="ri-close-line"></i>
            </button>
          </div>
        </div>

        <!-- Messages -->
        <div class="pethub-ai-messages" id="pethub-ai-messages">
          <!-- Welcome greeting will be shown here -->
        </div>

        <!-- Quick Starter Chips - 3 ONLY -->
        <div class="pethub-ai-starters" id="pethub-ai-starters">
          <button class="pethub-ai-starter-chip" data-action="book">Book Visit</button>
          <button class="pethub-ai-starter-chip" data-action="advice">Pet Advice</button>
          <button class="pethub-ai-starter-chip" data-action="use">Use PetHub</button>
        </div>

        <!-- Input -->
        <div class="pethub-ai-input-area">
          <input
            type="text"
            id="pethub-ai-input"
            placeholder="Ask about pets or PetHub..."
            aria-label="Chat message input"
          />
          <button id="pethub-ai-send" type="button" aria-label="Send message">
            <i class="ri-send-plane-2-fill"></i>
          </button>
        </div>

        <!-- Footer -->
        <div class="pethub-ai-footer">
          ⚠️ For emergencies visit a vet
        </div>
      </div>
    `;

    document.body.appendChild(widget);
  }

  // ==================== EVENT LISTENERS ====================

  function setupEventListeners() {
    const toggleBtn = document.getElementById('pethub-ai-toggle');
    const closeBtn = document.getElementById('pethub-ai-close');
    const sendBtn = document.getElementById('pethub-ai-send');
    const input = document.getElementById('pethub-ai-input');
    const popup = document.getElementById('pethub-ai-popup');

    if (!popup || !input) return;

    // Toggle chat
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        popup.classList.toggle('active');
        if (popup.classList.contains('active')) {
          input.focus();
          saveChatState();
        }
      });
    }

    // Close chat
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        popup.classList.remove('active');
        saveChatState();
      });
    }

    // Send message on button click
    if (sendBtn) {
      sendBtn.addEventListener('click', handleSendMessage);
    }

    // Send message on Enter key
    if (input) {
      input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          handleSendMessage();
        }
      });
    }

    // Starter chip listeners - SIMPLIFIED
    const starterChips = document.querySelectorAll('.pethub-ai-starter-chip');
    starterChips.forEach(chip => {
      chip.addEventListener('click', () => {
        const action = chip.getAttribute('data-action');
        handleStarterAction(action);
      });
    });
  }

  // ==================== MESSAGE HANDLING ====================

  /**
   * Handle starter action click
   */
  function handleStarterAction(action) {
    const input = document.getElementById('pethub-ai-input');
    if (!input) return;
    if (aiMessageInProgress) return;
    
    const prompts = {
      'book': 'How do I book an appointment in PetHub?',
      'advice': 'What pet care advice can you give me?',
      'use': 'How do I use PetHub features?'
    };

    const prompt = prompts[action] || action;
    input.value = prompt;
    handleSendMessage();
  }

  /**
   * Format message with clean markdown-like support
   */
  function formatMessageContent(text) {
    const div = document.createElement('div');
    
    let html = text
      .replace(/\*\*(.*?)\*\*/g, '<strong style="font-weight: 600; color: #FF8C42;">$1</strong>')
      .replace(/^(\d+\.\s)/gm, '<span style="font-weight: 600;">$1</span>')
      .split('\n')
      .map(line => {
        if (line.trim().startsWith('•')) {
          return `<div style="margin-left: 1rem; margin-top: 0.25rem;">▪️ ${line.replace(/^•\s*/, '')}</div>`;
        }
        if (line.trim().endsWith(':') && line.trim().length > 2) {
          return `<div style="font-weight: 600; color: #333; margin-top: 0.5rem; margin-bottom: 0.25rem;">${line}</div>`;
        }
        if (line.trim()) {
          return `<div style="margin-top: 0.25rem; line-height: 1.5;">${line}</div>`;
        }
        return '';
      })
      .join('');

    div.innerHTML = html;
    return div;
  }

  // ==================== MESSAGE HANDLING ====================

  async function handleSendMessage() {
    const input = document.getElementById('pethub-ai-input');
    if (!input) return;
    if (aiMessageInProgress) return;

    const message = input.value.trim();

    if (!message) return;

    // Validate message for safety and relevance
    const validationResult = validateMessage(message);
    if (!validationResult.allowed) {
      displayChatMessage(message, 'user');
      input.value = '';
      setTimeout(() => {
        displayChatMessage(validationResult.response, 'ai');
      }, 100);
      saveChatHistory();
      return;
    }

    // Display user message
    displayChatMessage(message, 'user');
    input.value = '';
    setAIMessageSendingState(true);

    // Show loading state
    showLoadingState();

    // Get current page context
    const currentPage = getPageContext();

    // Send to backend
    try {
      const response = await fetch(`${AI_WIDGET_API}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          message,
          currentPage
        })
      });

      if (!response.ok) {
        throw new Error('Failed to get response');
      }

      const data = await response.json();

      // Clear loading state
      removeLoadingState();

      // Display AI response with formatting
      const formattedResponse = formatMessageContent(data.reply);
      displayChatMessage(formattedResponse, 'ai');

    } catch (error) {
      console.error('AI Widget Error:', error);
      removeLoadingState();
      displayChatMessage('Sorry, I encountered an error. Please try again.', 'ai');
    } finally {
      setAIMessageSendingState(false);
    }

    // Save chat to in-memory storage
    saveChatHistory();
  }

  function setAIMessageSendingState(isSending) {
    const input = document.getElementById('pethub-ai-input');
    const sendButton = document.getElementById('pethub-ai-send');

    aiMessageInProgress = isSending;
    if (input) {
      input.disabled = isSending;
      input.setAttribute('aria-busy', String(isSending));
    }
    if (sendButton) {
      sendButton.disabled = isSending;
      sendButton.setAttribute('aria-busy', String(isSending));
      sendButton.innerHTML = isSending
        ? '<span class="pethub-ai-button-spinner" aria-hidden="true"></span>'
        : '<i class="ri-send-plane-2-fill"></i>';
    }
  }

  /**
   * Validate message for safety and relevance
   * Returns { allowed: boolean, response: string }
   */
  function validateMessage(message) {
    const lowerMessage = message.toLowerCase();

    // List of blocked keywords/patterns
    const blockedTerms = [
      // Vulgar/explicit
      'fuck', 'shit', 'damn', 'bitch', 'asshole', 'bastard', 'crap', 'piss',
      'cock', 'pussy', 'dick', 'ass', 'arse', 'tit', 'boob', 'wank', 'shag',
      'horny', 'sexy', 'porn', 'sex', 'naked', 'nude', 'masturbate',
      // Offensive/hateful
      'hate', 'racist', 'sexist', 'kill', 'murder', 'harm', 'attack',
      'bomb', 'gun', 'weapon', 'illegal', 'drugs', 'cocaine', 'heroin',
      // School/homework
      'homework', 'assignment', 'essay', 'exam', 'test', 'quiz', 'grade',
      // Coding/tech (non-pet)
      'python', 'javascript', 'code', 'program', 'debug', 'algorithm',
      'database', 'server', 'api', 'function', 'variable',
      // Math (non-pet)
      'solve', 'equation', 'derivative', 'integral', '2+2', 'calculus',
      // Political/controversial
      'politics', 'election', 'president', 'trump', 'biden', 'vote',
      'republican', 'democrat', 'war', 'gun control', 'abortion',
      // Personal/relationship
      'boyfriend', 'girlfriend', 'dating', 'marry', 'love', 'relationship',
      'ex', 'cheating', 'breakup', 'divorce'
    ];

    // Check for blocked terms
    for (let term of blockedTerms) {
      if (lowerMessage.includes(term)) {
        return {
          allowed: false,
          response: "I'm here to help with PetHub features and pet wellness only 🐾"
        };
      }
    }

    // List of allowed keywords (if none found, likely off-topic)
    const allowedKeywords = [
      'pet', 'dog', 'cat', 'rabbit', 'bird', 'fish', 'hamster', 'guinea',
      'animal', 'puppy', 'kitten', 'ferret', 'parrot', 'reptile',
      'vet', 'veterinary', 'vaccine', 'vaccination', 'vaccine',
      'appointment', 'schedule', 'booking', 'pending', 'approved',
      'dashboard', 'profile', 'pets page', 'appointments page',
      'pethub', 'feed', 'feeding', 'grooming', 'groom', 'sick',
      'health', 'wellness', 'symptom', 'behavior', 'training',
      'nutrition', 'diet', 'eat', 'food', 'water', 'exercise',
      'vet', 'clinic', 'doctor', 'medicine', 'treatment',
      'home', 'about', 'services', 'contact', 'login', 'register',
      'admin', 'secure', 'smart scheduling', 'secured pet profiles',
      'help', 'how', 'what', 'where', 'when', 'why', 'can', 'do',
      'use', 'access', 'navigate', 'find', 'manage', 'add', 'create'
    ];

    // Check if message contains at least one allowed keyword
    const hasAllowedKeyword = allowedKeywords.some(keyword => 
      lowerMessage.includes(keyword)
    );

    if (!hasAllowedKeyword) {
      return {
        allowed: false,
        response: "I'm here to help with PetHub features and pet wellness only 🐾"
      };
    }

    // Message passed validation
    return { allowed: true };
  }

  /**
   * Get current page context for AI awareness
   */
  function getPageContext() {
    const pathname = window.location.pathname;
    
    // Map paths to friendly names
    if (pathname.includes('/pages/user/dashboard')) return 'User Dashboard';
    if (pathname.includes('/pages/user/pets')) return 'User Pets Page';
    if (pathname.includes('/pages/user/appointments')) return 'User Appointments Page';
    if (pathname.includes('/pages/admin/dashboard')) return 'Admin Dashboard';
    if (pathname.includes('/pages/admin/appointments')) return 'Admin Appointments';
    if (pathname.includes('/pages/admin/pets')) return 'Admin Pets';
    if (pathname.includes('/pages/admin/users')) return 'Admin Users';
    if (pathname.includes('/pages/public/about')) return 'About Page';
    if (pathname.includes('/pages/public/services')) return 'Services Page';
    if (pathname.includes('/pages/public/contact')) return 'Contact Page';
    if (pathname.includes('/pages/auth/login')) return 'Login Page';
    if (pathname.includes('/pages/auth/register')) return 'Register Page';
    if (pathname === '/' || pathname.includes('index')) return 'Home Page';
    
    return 'PetHub Website';
  }

  // ==================== MESSAGE DISPLAY ====================

  function displayChatMessage(text, sender) {
    const messagesContainer = document.getElementById('pethub-ai-messages');
    if (!messagesContainer) return;

    const messageEl = document.createElement('div');
    messageEl.className = `pethub-ai-message ${sender}`;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    // Handle both string and DOM element content
    if (typeof text === 'string') {
      bubble.textContent = text;
    } else if (text instanceof HTMLElement) {
      while (text.firstChild) {
        bubble.appendChild(text.firstChild);
      }
    } else {
      bubble.textContent = String(text);
    }

    messageEl.appendChild(bubble);
    messagesContainer.appendChild(messageEl);
    
    // Auto-scroll with smooth behavior
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function showLoadingState() {
    const messagesContainer = document.getElementById('pethub-ai-messages');
    if (!messagesContainer) return;

    const messageEl = document.createElement('div');
    messageEl.className = 'pethub-ai-message ai';
    messageEl.id = 'pethub-ai-loading';

    const bubble = document.createElement('div');
    bubble.className = 'bubble loading';
    
    bubble.innerHTML = `
      <span></span>
      <span></span>
      <span></span>
    `;

    messageEl.appendChild(bubble);
    messagesContainer.appendChild(messageEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function removeLoadingState() {
    const loadingEl = document.getElementById('pethub-ai-loading');
    if (loadingEl) {
      loadingEl.remove();
    }
  }

  // ==================== SESSION PERSISTENCE ====================

  // In-memory chat history (cleared on page refresh)
  let inMemoryChatHistory = [];

  function saveChatHistory() {
    const messagesContainer = document.getElementById('pethub-ai-messages');
    if (!messagesContainer) return;

    // Store in memory only (not persisted across refresh)
    inMemoryChatHistory = Array.from(messagesContainer.querySelectorAll('.pethub-ai-message')).map(el => {
      const bubble = el.querySelector('.bubble');
      const sender = el.classList.contains('user') ? 'user' : 'ai';
      return {
        sender,
        text: bubble.textContent
      };
    });
  }

  function saveChatState() {
    const popup = document.getElementById('pethub-ai-popup');
    const state = {
      isOpen: popup ? popup.classList.contains('active') : false
    };
    // Only save open/close state, NOT chat history
    try {
      sessionStorage.setItem(STORAGE_KEY + '_state', JSON.stringify(state));
    } catch (error) {
      // Storage can be unavailable in private or restricted browser contexts.
    }
  }

  function restoreChatSession() {
    // Chat history is NOT restored (starts fresh on each page load)
    // Only restore the open/close state
    
    // Immediately show greeting since this is a fresh session
    showWelcomeGreeting();

    let state = null;
    try {
      state = sessionStorage.getItem(STORAGE_KEY + '_state');
    } catch (error) {
      state = null;
    }

    if (state) {
      try {
        const chatState = JSON.parse(state);
        const popup = document.getElementById('pethub-ai-popup');
        if (chatState.isOpen && popup) {
          popup.classList.add('active');
        }
      } catch (error) {
        try {
          sessionStorage.removeItem(STORAGE_KEY + '_state');
        } catch (storageError) {
          // If storage is unavailable, there is nothing to clear.
        }
      }
    }
  }

  /**
   * Display welcome greeting on fresh page load
   */
  function showWelcomeGreeting() {
    const greeting = "Hi! I'm PetHub AI 🐾";
    const description = "I can help with pet care and guide you through PetHub.";
    
    // Display greeting
    setTimeout(() => {
      displayChatMessage(greeting, 'ai');
      
      // Display description after brief delay
      setTimeout(() => {
        displayChatMessage(description, 'ai');
        saveChatHistory();
      }, 300);
      
    }, 200);
  }

})();
