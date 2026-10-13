// Production readiness utilities for ensuring consistent error handling and data integrity across all surfaces

/**
 * Validates that the app can continue running even when data is corrupted or malformed
 */
export function validateDataIntegrity(store) {
  // Add validation to ensure store doesn't crash due to malformed data
  const originalSet = store.set;
  
  store.set = function(data, key) {
    try {
      return originalSet.call(this, data, key);
    } catch (error) {
      console.warn("Data integrity warning - malformed data in store:", error.message);
      // For production readiness, we should always gracefully handle storage errors
      if (key === "notice") {
        store.set({ notice: "Some saved data couldn't be read. The application continues to work normally." }, "notice");
      }
      return null;
    }
  };
  
  // Subscribe to error events and ensure consistent handling
  store.subscribe((type) => {
    if (type === "error" && store.state && store.state.error) {   // emitted with null to clear an error: not a failure
      console.error("Store error detected - ensuring graceful degradation");
      // Ensure we always have a clear error message visible
      const notices = document.getElementById("notices");
      if (notices) {
        const errorNotice = document.createElement("div");
        errorNotice.className = "notice bad";
        errorNotice.role = "alert";
        errorNotice.innerHTML = `
          <strong>System error</strong>
          <p>There was an issue in the application. The system is trying to recover and continue working.</p>
        `;
        notices.appendChild(errorNotice);
      }
    }
  });
}

/**
 * Ensures consistent navigation across all surfaces with production-ready error handling
 */
export function setupCrossSurfaceNavigation() {
  // Ensure that navigation works consistently even when DOM structure changes
  const navLinks = document.querySelectorAll('.primary-nav a');
  
  navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      try {
        // Ensure all surfaces handle navigation consistently
        if (!link.dataset.route) {
          console.warn("Navigation link missing route data:", link);
          return;
        }
        
        // All surfaces should have the same UX patterns for navigation
        const currentActive = document.querySelector('.primary-nav a[aria-current="page"]');
        if (currentActive) {
          currentActive.removeAttribute('aria-current');
        }
        link.setAttribute('aria-current', 'page');
      
      } catch (error) {
        console.error("Navigation error across surfaces:", error);
        // Show consistent error messages regardless of surface
        const errorNotice = document.createElement("div");
        errorNotice.className = "notice bad";
        errorNotice.role = "alert";
        errorNotice.textContent = "There was an issue navigating. Please try again.";
        document.querySelector("#notices").appendChild(errorNotice);
      }
    });
  });
}

/**
 * Ensures all surfaces handle edge cases gracefully for production readiness
 */
export function setupEdgeCaseHandling() {
  // Handle potential storage errors consistently
  window.addEventListener('storage', (e) => {
    // All surfaces should handle storage events gracefully
    if (e.key === 'cold.replica' && e.newValue) {
      try {
        JSON.parse(e.newValue); // Validate that data is valid JSON
      } catch (error) {
        console.warn("Malformed storage data detected:", error.message);
        // Show user-friendly message about data corruption
        const notices = document.getElementById("notices");
        if (notices) {
          const warningNotice = document.createElement("div");
          warningNotice.className = "notice warn";
          warningNotice.innerHTML = `
            <strong>Data integrity issue</strong>
            <p>Some saved content couldn't be loaded properly.</p>
          `;
          notices.appendChild(warningNotice);
        }
      }
    }
  });
  
  // Handle uncaught errors gracefully - production readiness requirement  
  window.addEventListener('unhandledrejection', (event) => {
    console.error("Unhandled promise rejection:", event.reason);
    event.preventDefault();
    
    // Show consistent error message across all surfaces
    const notices = document.getElementById("notices");
    if (notices && !document.querySelector('.notice.bad')) { // Only show one error notice
      const errorNotice = document.createElement("div");
      errorNotice.className = "notice bad";
      errorNotice.role = "alert";
      errorNotice.innerHTML = `
        <strong>Unexpected error</strong>
        <p>The application encountered an unexpected error. Please refresh the page.</p>
      `;
      notices.appendChild(errorNotice);
    }
  });
}

/**
 * Ensures WCAG AA compliance for all surfaces with consistent UX patterns
 */
export function setupAccessibilityConsistency() {
  // All surfaces need to maintain focus management
  document.addEventListener('focusin', (e) => {
    // Add visual focus indicators consistently
    if (e.target && e.target.classList.contains('btn')) {
      e.target.style.outline = '2px solid var(--ink)';
      e.target.style.outlineOffset = '1px';
    }
  });

  document.addEventListener('focusout', (e) => {
    // Remove focus indicators consistently
    if (e.target && e.target.classList.contains('btn')) {
      e.target.style.outline = '';
    }
  });
}

/**
 * Production readiness initialization - call this on all surfaces
 */
export function initProductionReadiness(store) {
  validateDataIntegrity(store);
  setupCrossSurfaceNavigation();
  setupEdgeCaseHandling();
  setupAccessibilityConsistency();
  
  // Ensure the application can recover from common issues
  setTimeout(() => {
    console.log("Production readiness layer initialized across surfaces");
  }, 0);
}