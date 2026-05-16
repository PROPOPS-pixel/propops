# Relio Landing Page — Mobile Responsiveness Issues Found

## Critical Issues (Will Break UX)

### 1. **Button Touch Targets Too Small**
- **Location**: Hero form, footer form, pricing CTA
- **Current**: 0.85rem padding = ~13.6px (height ~42px with font)
- **Issue**: Touch targets should be minimum 44x44px (Apple) or 48x48px (Android)
- **Current state**: 43.6px ≈ Below recommended minimum
- **Fix**: Increase button padding to 1rem minimum on mobile

### 2. **Form Inputs Have Inadequate Tap Size on Mobile**
- **Location**: `.email-form input`
- **Current**: `padding: 0.85rem 1rem` = 13.6px height
- **Issue**: Height is ~41px with font-size 1rem, below 44px minimum
- **Fix**: Mobile-specific larger padding

### 3. **Nav CTA Button Too Small on Mobile**
- **Location**: `.nav-cta`
- **Current**: `padding: 0.5rem 1.25rem` = 8px height
- **Issue**: Tiny button, hard to tap on mobile
- **Should be**: At least 44px height minimum

### 4. **No Mobile-Specific Padding for Small Phones**
- **Location**: All sections
- **Issue**: 1.5rem (24px) horizontal padding might be tight on 320px phones
- **Missing**: `@media (max-width: 360px)` with reduced padding

### 5. **Hero Subtitle Text Too Large on Mobile**
- **Location**: `.hero-sub`
- **Current**: Fixed `1.15rem` at all sizes
- **Issue**: On 375px phone, large subtitle can wrap awkwardly
- **Fix**: Use clamp() for responsive sizing

### 6. **FAQ Chevron Icon Size Inconsistent**
- **Location**: `.faq-chevron`
- **Current**: Fixed `28px` width/height
- **On mobile**: Might be hard to tap reliably (below 44px)
- **Fix**: Increase to 36-40px minimum, or make larger touch area

### 7. **Pricing Card Padding Insufficient on Mobile**
- **Location**: `.pricing-card @media`
- **Current**: `padding: 2rem` = 32px
- **Issue**: On narrow mobile, content feels cramped
- **Fix**: Increase to 1.5rem horizontal only, keep 2rem vertical

### 8. **Compare Table Font Too Small on Mobile**
- **Location**: `.compare-row`
- **Current**: `font-size: 0.78rem` at 768px breakpoint
- **Issue**: 0.78rem ≈ 12.5px, hard to read on small screens
- **Fix**: Keep at least 0.85rem minimum for readability

### 9. **Pain Stat Icons Small on Mobile**
- **Location**: `.pain-stat-icon`
- **Current**: Fixed `36px` width/height
- **On mobile**: Icon inside is only ~18px font size, hard to see
- **Fix**: Keep at 36px but ensure emoji is readable

### 10. **Missing Breakpoint for Very Small Phones**
- **Current**: Only 768px and 480px breakpoints
- **Missing**: Specific handling for 320-375px phones (largest gap)
- **Fix**: Add `@media (max-width: 360px)` breakpoint

---

## Medium Issues (Will Affect UX But Not Breaking)

### 11. **Step Card Hover Effect Blocks Touch**
- **Location**: `.step-card:hover` has `box-shadow`
- **On mobile**: Unnecessary, wastes rendering. Remove on touch devices.
- **Fix**: Use `@media (hover: hover)` to exclude touch

### 12. **Feature Card Hover Effect**
- **Location**: `.feature-card:hover`
- **Issue**: Same as above — not needed on mobile
- **Fix**: Add `@media (hover: hover)`

### 13. **No Media Query for Print**
- **Not critical** but good practice

### 14. **Pricing "Most Popular" Badge Position**
- **Location**: `.pricing-popular`
- **Current**: `top: -14px` positioned
- **On mobile**: Might overlap if content shifts
- **Should be OK** but verify rendering

### 15. **Video Aspect Ratio Fixed at 16:9**
- **Location**: `.video-aspect` padding-bottom: 56.25%
- **Status**: ✓ This is correct and responsive

---

## Minor Issues (Polish)

### 16. **Flow Arrows Emoji Might Not Scale Well**
- **Location**: Flow section arrows (→, rotated ↓ on mobile)
- **On mobile**: Font-size 1.5rem might be too large
- **Fix**: Reduce to 1.2rem on mobile

### 17. **Stat Bar Font Sizes Fixed**
- **Location**: `.stat-number` clamped but `.stat-label` fixed `0.8rem`
- **On mobile**: Could be responsive too

### 18. **FAQ Question Text Might Wrap Awkwardly**
- **Location**: `.faq-question h4`
- **Current**: No line-height adjustment for mobile
- **On narrow screens**: Line height 1.45 might stack weirdly
- **Minor issue**: OK as-is but could improve

---

## Things That Are Actually Good ✓

- ✓ Hero H1 uses clamp() — excellent responsive typography
- ✓ Video aspect ratio 56.25% — perfect for responsive video
- ✓ Email form converts to column layout on mobile
- ✓ Grids collapse to single column
- ✓ Container max-width 1120px prevents excessive width
- ✓ Nav links hidden appropriately on mobile

---

## Priority Fixes

**MUST FIX** (breaking UX):
1. Button touch targets (44px minimum)
2. Form input touch targets (44px minimum)
3. Nav CTA button size on mobile
4. FAQ chevron touch target

**SHOULD FIX** (affects usability):
5. Tiny compare table font (0.78rem)
6. Missing breakpoint for 320-360px phones
7. Remove hover effects on touch devices

**NICE TO HAVE** (polish):
8. Clamp hero subtitle for better mobile fit
9. Adjust flow arrow size
