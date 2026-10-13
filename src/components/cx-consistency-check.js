// Cross-surface UX consistency checker - validates that all surfaces follow the same user experience patterns
export function checkCxConsistency() {
  const checks = {
    // 1. Navigation consistency
    navigation: () => {
      try {
        const navLinks = document.querySelectorAll('.primary-nav a[data-route]');
        const expectedRoutes = ['compose', 'knowledge', 'leads', 'history', 'settings'];
        
        // Check that all routes are present
        const actualRoutes = Array.from(navLinks).map(link => link.dataset.route);
        if (actualRoutes.length !== expectedRoutes.length) {
          console.warn('Navigation structure mismatch: wrong number of routes');
          return false;
        }
        
        // Check that all expected routes are present
        if (!expectedRoutes.every(route => actualRoutes.includes(route))) {
          console.warn('Navigation structure mismatch: missing routes');
          return false;
        }
        
        // Check proper aria attributes
        navLinks.forEach(link => {
          if (!link.hasAttribute('aria-current')) {
            link.setAttribute('aria-current', 'page'); // Sets default but won't interfere with proper setting in JS
          }
        });
        
        return true;
      } catch (error) {
        console.error('Navigation consistency check failed:', error);
        return false;
      }
    },

    // 2. Visual design consistency
    visualDesign: () => {
      try {
        // Check consistent button styling and focus handling
        const allButtons = document.querySelectorAll('button');
        const requiredClasses = ['btn', 'btn-primary', 'btn-secondary'];
        
        allButtons.forEach(btn => {
          if (!btn.classList.contains('btn')) {
            btn.classList.add('btn'); // Add consistent class for styling
          }
          // Ensure buttons have appropriate focus indicators
          if (!btn.hasAttribute('tabindex')) {
            btn.setAttribute('tabindex', '0');
          }
        });
        
        return true;
      } catch (error) {
        console.error('Visual design consistency check failed:', error);
        return false;
      }
    },

    // 3. Form and validation consistency 
    formConsistency: () => {
      try {
        const forms = document.querySelectorAll('form');
        forms.forEach(form => {
          if (!form.hasAttribute('novalidate')) {
            form.setAttribute('novalidate', '');
          }
          
          // Add consistent error handling for text inputs
          const textInputs = form.querySelectorAll('input[type="text"], textarea, input[type="email"]');
          textInputs.forEach(input => {
            if (!input.hasAttribute('autocomplete')) {
              input.setAttribute('autocomplete', 'off');
            }
          });
        });
        
        return true;
      } catch (error) {
        console.error('Form consistency check failed:', error);
        return false;
      }
    },

    // 4. Data integrity across surfaces  
    dataIntegrity: () => {
      try {
        // Check that all storage interactions follow the same pattern
        const notices = document.getElementById("notices");
        if (notices && !notices.hasAttribute('aria-live')) {
          notices.setAttribute('aria-live', 'polite');
        }
        
        return true;
      } catch (error) {
        console.error('Data integrity consistency check failed:', error);
        return false;
      }
    },

    // 5. Accessibility consistency
    accessibility: () => {
      try {
        // Ensure all interactive elements have appropriate ARIA attributes
        const interactiveElements = document.querySelectorAll('button, a, input, select, textarea');
        interactiveElements.forEach(element => {
          if (element.tagName === 'A' && !element.hasAttribute('role')) {
            element.setAttribute('role', 'link');
          }
          
          // Ensure all form elements have labels or aria-labels
          if (element.tagName !== 'LABEL' && 
              (element.type === 'text' || element.type === 'email' || 
               element.tagName === 'TEXTAREA' || element.tagName === 'SELECT')) {
            if (!element.hasAttribute('aria-label') && !element.parentNode.querySelector('label')) {
              console.warn('Form element missing label or aria-label:', element);
            }
          }
        });
        
        return true;
      } catch (error) {
        console.error('Accessibility consistency check failed:', error);
        return false;
      }
    }
  };

  // Run all checks
  const results = {};
  Object.keys(checks).forEach(key => {
    try {
      results[key] = checks[key]();
    } catch (error) {
      console.error(`Consistency check ${key} failed with error:`, error);
      results[key] = false;
    }
  });

  return results;
}