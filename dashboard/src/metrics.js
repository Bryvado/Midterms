// The same published fields and kinds drive the menu, map scales and place details.
export const demographicMeasures = [
  { key:'population', label:'Population', kind:'count' },
  { key:'cvap_total', label:'Citizen voting-age population', kind:'count' },
  { key:'hisp_cvap_share', label:'Hispanic share of CVAP', kind:'bounded' },
  { key:'white_cvap_share', label:'White share of CVAP', kind:'bounded' },
  { key:'black_cvap_share', label:'Black share of CVAP', kind:'bounded' },
  { key:'ba_plus_share', label:"Bachelor's degree or higher", kind:'bounded' },
  { key:'med_income', label:'Average of precinct median incomes', kind:'money' },
];
export const electorateMeasures = [
  { key:'registered_2024', label:'Registered voters, 2024', kind:'count' },
  { key:'voted_2022', label:'Voted in 2022', kind:'count' },
];
export const placeMeasures = [...demographicMeasures, ...electorateMeasures];
export const measureLabel = (metric, unit) => metric.key === 'med_income' && unit === 'precinct' ? 'Median income' : metric.label;
