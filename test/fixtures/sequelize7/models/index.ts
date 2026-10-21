import { Category } from './category.js';
import { Post } from './post.js';
import { Profile } from './profile.js';
import { Tag } from './tag.js';
import { User } from './user.js';

export { Category, Post, Profile, Tag, User };

/** Every model, for `new Sequelize({ dialect, models })`. */
export const models = [Category, Post, Profile, Tag, User];
