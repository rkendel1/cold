# Cross-Surface User Experience Standards

> **Status: aspirational standards, not a description of the product.** Several statements here are targets (for example about error handling and consistency checks); the audit found that the supporting code (`src/components/production-readiness.js`, `cx-consistency-check.js`) does not deliver all of them and in places masks failures. Use [docs/audit](../audit/README.md) for what is true; treat this as a design brief. See DOCS-004 and QUALITY-005.

This document defines the user experience standards that ensure consistent, production-ready experience across all surfaces of Cold: web app, desktop app, and browser extension.

## 1. Core Principles

### Single Surface Value Delivery
Each surface must be fully functional and provide complete value without requiring any other surface. Users should be able to achieve their goals using a single surface without dependency on others.

### Production Readiness 
All surfaces must handle edge cases gracefully, show clear error messages, and maintain data integrity. No surface should crash or become unusable due to malformed data or storage issues.

### Cross-Surface Consistency
UI components, interaction patterns, terminology, and user workflows must be consistent across all surfaces while maintaining platform-specific optimizations.

## 2. UX Guidelines

### 2.1 Navigation and Layout
- **Consistent Navigation**: All surfaces must maintain the same primary navigation structure: Write → Knowledge → History → Settings
- **Responsive Design**: Layouts must adapt to different screen sizes while maintaining usability (mobile, tablet, desktop)
- **Platform conventions**: 
  - Web: Desktop-like experience with hash routing
  - Desktop: Full-window application experience with standard OS window controls
  - Extension: Chrome panel-style interface with fixed positioning

### 2.2 User Journey Mapping

#### First-time User Experience
1. **Onboarding flow** (same across surfaces):
   - Clear initial instructions on how to get started
   - Help text explaining the three-sentence email structure
   - Context-sensitive help that doesn't require external links
2. **No fictional data**: Each surface should start with empty forms, not prefilled data
3. **Zero-knowledge setup**: Users can immediately start working without prerequisites

#### Core User Workflow
1. **Compose Email**
   - Consistent prompts and data collection process
   - Same validation error handling across surfaces
   - Same interaction patterns for editing (copy, save, mark as sent)
2. **Knowledge Management**
   - Same product editor interface (dropdown to select product for editing)
   - Consistent readiness indicators and proof organization
   - Same internal/external use separation logic
3. **History and Tracking**
   - Same status labels and filtering capabilities
   - Consistent interaction patterns (mark as sent, reply recording)
   - Same search and sorting functionality

### 2.3 Visual Design Consistency

#### Typography
- Use the same font stack across surfaces (system fonts where possible)
- Maintain consistent text sizes, weights, and line heights
- Same heading hierarchy throughout all views

#### Color Palette
- Shared color tokens for primary actions, warnings, errors, and success states
- Consistent use of semantic colors with appropriate contrast ratios
- Same treatment of disabled states, focus indicators, and interactive elements

#### Components
- Reusable UI components that behave identically across surfaces
- Consistent spacing and alignment using shared CSS variables
- Same component states (hover, active, focus, disabled, error)

### 2.4 Interaction Patterns

#### Forms and Validation
1. **Field labeling**: All fields must be clearly labeled as Required or Optional
2. **Error handling**: 
   - Each field has inline validation messages
   - Summary errors at top of form with links to relevant fields (ARIA compliant)
   - Consistent error types and messaging across surfaces
3. **Data saving**: 
   - Auto-save during user input where appropriate
   - Clear status feedback for save operations
   - Validation before save operations

#### Data Management
1. **Editing behavior**:
   - Unsaved edits are protected by confirmation dialogs
   - Changes are persistent across page reloads
   - Clear indication of what is being edited
2. **Deletion and modification**:
   - Confirmation dialogs for destructive actions
   - Clear visual feedback for operations
3. **Import/Export capabilities**:
   - Same workflow options across surfaces
   - Consistent success/error messaging

### 2.5 Data Flow Consistency

#### Storage Implementation
- **Web**: localStorage 
- **Desktop**: SQLite database (hub)
- **Extension**: chrome.storage.local
- All surfaces must gracefully handle storage errors (full quota, permission issues)

#### Sync Behavior
1. **No implicit dependencies required**
   - Users can function on a single surface without connectivity to others
   - Data synchronization between paired surfaces is optional convenience
2. **Conflict resolution**:
   - When data conflicts occur, newer changes override older ones
   - No manual merge operations needed
3. **Offline handling**:
   - All functionality available in offline mode
   - Changes persist and sync when connectivity returns

### 2.6 Accessibility and Usability

#### Platform Accessiblity Compliance
1. **WCAG 2.1 AA compliance** on all surfaces
2. **Screen reader accessibility**:
   - Proper ARIA roles and properties for all UI elements 
   - Skip links for keyboard navigation
   - Meaningful focus indicators
3. **Keyboard navigation**: Same navigation patterns across all surfaces
4. **Contrast ratios**: Consistent minimum 4.5:1 ratio for text elements

#### Input Methods
- Support for multiple input methods (mouse, keyboard, touch)
- Responsive controls that meet minimum 44px target size
- Clear visual feedback for interactions

## 3. Surface-Specific Adaptations

### 3.1 Web App
- Full-width page experience
- Hash-based routing system
- Responsive layout for different screen sizes
- Accessible on static hosts and Vercel's single-handler setup

### 3.2 Desktop App  
- Native window controls and OS integration
- Full local database access with SQLite
- Keychain-based storage for provider credentials
- Hub functionality for synchronization

### 3.3 Browser Extension
- Chrome panel-style interface
- Minimal space usage within browser tab
- Page-specific content extraction capabilities
- Access to current page information for enhanced workflows

## 4. Quality Assurance Requirements

### 4.1 Testing Coverage
All surfaces must be independently testable with:
1. **Functional tests**: Each surface works on its own 
2. **Integration tests**: Data flows work across paired surfaces
3. **Regression tests**: No behavior changes for existing functionality
4. **Edge case coverage**: Malformed data, storage limits, network issues

### 4.2 Production Readiness Checks  
1. **Crash handling**: No surface crashes or becomes unusable due to data corruption
2. **Data integrity**: All surfaces handle malformed saved data gracefully
3. **Error reporting**: Clear, actionable error messages for users
4. **Performance**: Responsive UI across all surfaces with reasonable load times

## 5. Implementation Standards

### 5.1 Code Structure
- Shared components in `src/components/`, styles in `src/styles/`
- Surface-specific adapters that maintain shared interfaces 
- Consistent module naming and organization patterns
- Single source of truth for domain logic (`src/domain/*`)

### 5.2 Design System
- CSS variables for consistent theming
- Reusable UI components with consistent props
- Shared interaction patterns and user flows
- Component documentation and usage guides

## 6. Monitoring and Improvements

### 6.1 Feedback Loop
- Regular UX audits across all surfaces
- User behavior tracking to identify inconsistencies
- Continuous improvement based on user feedback and testing
- Documentation updates with each surface enhancement

This document serves as the authoritative source for maintaining production-ready, cross-surface UX standards in Cold.