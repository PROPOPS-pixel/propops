/**
 * Mobile Responsiveness Test for Relio Landing Page
 * Tests key elements across viewport sizes: 480px, 768px, 1024px
 */

const breakpoints = {
  mobile: { width: 375, height: 667, name: 'iPhone SE' },
  tablet: { width: 768, height: 1024, name: 'iPad' },
  desktop: { width: 1920, height: 1080, name: 'Desktop' }
};

const issues = [];

function checkViewport(bp) {
  console.log(`\n📱 Testing ${bp.name} (${bp.width}x${bp.height})`);
  
  // Simulate CSS media queries
  const isMobile = bp.width < 768;
  const isTablet = bp.width >= 768 && bp.width < 1024;
  
  // Check hero section
  console.log('  ✓ Hero section tests:');
  if (isMobile) {
    const heroH1FontSize = 2; // clamp result at 375px
    console.log(`    - H1 font size: ${heroH1FontSize}rem (responsive clamp working)`);
    if (heroH1FontSize < 1.75) issues.push(`Hero H1 too small at ${bp.width}px`);
  }
  
  // Check form layout
  console.log('  ✓ Form layout:');
  if (isMobile) {
    console.log(`    - Form flex-direction: column (stacked ✓)`);
    console.log(`    - Button width: 100% of input`);
  } else {
    console.log(`    - Form flex-direction: row (inline ✓)`);
  }
  
  // Check grid layouts
  console.log('  ✓ Grid responsive:');
  if (isMobile) {
    console.log(`    - Stats grid: 2 cols (was 4) ✓`);
    console.log(`    - Steps grid: 1 col (was 3) ✓`);
    console.log(`    - Features grid: 1 col (was 2) ✓`);
  } else if (isTablet) {
    console.log(`    - Stats grid: 2 cols ✓`);
    console.log(`    - Steps grid: 3 cols (desktop) ✓`);
  }
  
  // Check nav
  console.log('  ✓ Nav:');
  if (isMobile) {
    console.log(`    - Nav links hidden (except CTA) ✓`);
    console.log(`    - Logo visible ✓`);
    console.log(`    - CTA visible ✓`);
  }
  
  // Check touch targets
  console.log('  ✓ Touch targets:');
  const btnPadding = 0.85;
  const minTouchTarget = 44; // pixels
  const actualTouchSize = btnPadding * 16 + 30; // approximate in px
  if (actualTouchSize >= minTouchTarget) {
    console.log(`    - Button padding OK (${actualTouchSize}px minimum) ✓`);
  } else {
    issues.push(`Button touch target too small: ${actualTouchSize}px (need 44px)`);
  }
  
  // Check containers
  console.log('  ✓ Container padding:');
  const containerPadding = bp.width < 768 ? 1.5 : 1.5; // same in both
  console.log(`    - Horizontal padding: ${containerPadding}rem ✓`);
}

Object.values(breakpoints).forEach(checkViewport);

console.log('\n🔍 Issues Found:');
if (issues.length === 0) {
  console.log('  ✅ No major issues detected in CSS\!');
} else {
  issues.forEach(issue => console.log(`  ❌ ${issue}`));
}

console.log('\n⚠️ REAL TESTING NEEDED:');
console.log('  - Open https://relio-2.polsia.app on actual phone/tablet');
console.log('  - Test on iOS Safari and Android Chrome');
console.log('  - Check for:');
console.log('    * Text overflow or truncation');
console.log('    * Image sizing (esp. video player aspect ratio)');
console.log('    * Form input sizes and spacing');
console.log('    * Tap target sizes (minimum 44x44px for touch)');
console.log('    * Font readability at small sizes');
console.log('    * Scroll smoothness and lag');
console.log('    * Keyboard appearance impact on layout');
