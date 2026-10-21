import type { Sequelize } from 'sequelize';
import { User } from './user.js';
import { Category } from './category.js';
import { Post } from './post.js';
import { Tag } from './tag.js';
import { PostTags } from './postTags.js';
import { Profile } from './profile.js';

export { User, Category, Post, Tag, PostTags, Profile };

/** Initializes every model on a Sequelize instance, then sets up the associations. */
export function initModels(sequelize: Sequelize) {
  User.initModel(sequelize);
  Category.initModel(sequelize);
  Post.initModel(sequelize);
  Tag.initModel(sequelize);
  PostTags.initModel(sequelize);
  Profile.initModel(sequelize);

  return { User, Category, Post, Tag, PostTags, Profile };
}

export type Models = ReturnType<typeof initModels>;
