// Published statewide dates. South Morang uses the metropolitan Melbourne Cup date.
// Sources: https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2026
// https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2027
const published = {
  2026: ['01-01', '01-26', '03-09', '04-03', '04-04', '04-05', '04-06', '04-25', '06-08', '09-25', '11-03', '12-25', '12-26', '12-28'],
  2027: ['01-01', '01-26', '03-08', '03-26', '03-27', '03-28', '03-29', '04-25', '06-14', '11-02', '12-25', '12-26', '12-27', '12-28'],
};
const dates = Object.entries(published).flatMap(([year, days]) => days.map(day => `${year}-${day}`));
function holidays(settings) { return [...new Set([...dates.filter(date => !(settings?.removedDates || []).includes(date)), ...(settings?.extraDates || [])])].sort(); }
const info = { years: [2026, 2027], warning: 'The 2027 AFL Grand Final holiday is not yet confirmed in the published Victorian Government calendar. Add it when confirmed.',
  sources: ['https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2026', 'https://business.vic.gov.au/business-information/public-holidays/victorian-public-holidays-2027'] };
module.exports = { holidays, info, dates };
