import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from '../../src/App';

describe('App home', () => {
  it('shows the product promise and a path to add a novel', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('让小说成为你可以进入的世界');
    expect(screen.getByRole('button', { name: /开始一个新故事/ })).toBeInTheDocument();
  });
});
