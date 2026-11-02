import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './call-records.css';
import './dashboard.css';
import './organic.css';
import './call-filters.css';
import { MotionConfig } from 'motion/react';
import { IconContext } from '@phosphor-icons/react';

createRoot(document.getElementById('root')!).render(<React.StrictMode><MotionConfig reducedMotion="user"><IconContext.Provider value={{ size: 20, weight: 'regular' }}><App /></IconContext.Provider></MotionConfig></React.StrictMode>);
