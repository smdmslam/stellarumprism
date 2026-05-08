---
name: o2ui-creative-toolkit
description: A design skill focused on creating a UI toolkit inspired by modern design principles, merging functionality with aesthetics.
origin: O2UI
---

# O2UI Creative Toolkit

## Overview
This skill is aimed at developing a streamlined, card-based UI toolkit that fosters creativity while ensuring user engagement through modern design language. 

### Key Design Principles
- **Soft Colors**: Utilize a color palette that combines pastel hues with darker accents for effective contrast.
- **Whitespace**: Ensure sufficient spacing between elements to enhance visual clarity and focus.
- **Interactive Elements**: Incorporate buttons and sliders that fit the soft, rounded aesthetic seen in modern templates.

## Components
1. **Cards**: Display key features/events. 
   - **Layout**: Each card should have rounded corners, slight shadows, and a clear title with a descriptive body.
   - **Action Button**: Include an interactive call-to-action button on each card.

2. **Navigation**:
   - Simplified navigation bar that complements card design, with hover effects that provide user feedback.
   - Use clear typography that maintains a hierarchy.

3. **Typography**:
   - Use a bold typeface for headers and a simpler, more readable font for body text.
   - Maintain text size ratio for different devices, ensuring accessibility and readability.

## Responsive Design
- Ensure all elements adapt to varying screen sizes while retaining usability.
- Test layout at various resolutions to guarantee card visibility and interaction without horizontal scrolling.

## Example CSS Snippets
```css
/* BASE STYLES */
body {
    margin: 0;
    font-family: 'Your Font', sans-serif;
    background-color: #F9F9F9;
}

.card {
    border-radius: 8px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
    padding: 16px;
    background-color: #FFFFFF;
}

.card:hover {
    transform: scale(1.01);
    transition: transform 0.2s;
}
```

## Checklist
- [ ] Card design visually aligns with O2UI aesthetic.
- [ ] Button functionality is clearly defined and user-friendly.
- [ ] Typography is legible across all devices.

## Next Steps
Implement interactions and gather user feedback during prototype testing to refine this toolkit for broader use in design scenarios.