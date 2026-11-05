// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { CsvTablePreview } from '../../src/renderer/src/components/FileManager/CsvTablePreview';

describe('CsvTablePreview', () => {
  const sampleCsv = 'Name,Age,City\nAlice,30,Stockholm\nBob,25,Gothenburg\nCharlie,35,Malmo';

  it('renders table headers with group class and displays row data', () => {
    render(<CsvTablePreview csvContent={sampleCsv} fileName="people.csv" />);

    expect(screen.getByTestId('csv-table-preview')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Stockholm')).toBeInTheDocument();

    const headers = screen.getAllByRole('columnheader');
    // headers[0] is '#', headers[1..3] are Name, Age, City
    expect(headers[1]).toHaveTextContent('Name');
    expect(headers[1].className).toContain('group');
    expect(headers[2]).toHaveTextContent('Age');
    expect(headers[2].className).toContain('group');
  });

  it('sorts numeric and string columns on header click', () => {
    render(<CsvTablePreview csvContent={sampleCsv} fileName="people.csv" />);

    const ageHeader = screen.getByText('Age').closest('th')!;

    // Click Age -> Sort ascending by age (25, 30, 35)
    fireEvent.click(ageHeader);
    const rowsAsc = screen.getAllByRole('row');
    // rowsAsc[0] is the header row, rowsAsc[1] is Bob (25)
    expect(rowsAsc[1]).toHaveTextContent('Bob');

    // Click Age again -> Sort descending by age (35, 30, 25)
    fireEvent.click(ageHeader);
    const rowsDesc = screen.getAllByRole('row');
    expect(rowsDesc[1]).toHaveTextContent('Charlie');
  });

  it('filters rows based on search input', () => {
    render(<CsvTablePreview csvContent={sampleCsv} fileName="people.csv" />);

    const searchInput = screen.getByPlaceholderText('Filter table rows...');
    fireEvent.change(searchInput, { target: { value: 'Malmo' } });

    expect(screen.getByText('Charlie')).toBeInTheDocument();
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
  });
});
