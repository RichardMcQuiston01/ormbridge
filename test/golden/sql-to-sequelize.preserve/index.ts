import type { Sequelize } from 'sequelize';
import { BlogUser } from './blogUser.js';
import { BlogCategory } from './blogCategory.js';
import { BlogTag } from './blogTag.js';
import { BlogPost } from './blogPost.js';
import { BlogProfile } from './blogProfile.js';

export { BlogUser, BlogCategory, BlogTag, BlogPost, BlogProfile };

/** Initializes every model on a Sequelize instance, then sets up the associations. */
export function initModels(sequelize: Sequelize) {
  BlogUser.initModel(sequelize);
  BlogCategory.initModel(sequelize);
  BlogTag.initModel(sequelize);
  BlogPost.initModel(sequelize);
  BlogProfile.initModel(sequelize);

  BlogCategory.belongsTo(BlogCategory, {
    as: 'parent',
    foreignKey: 'parent_id',
    onDelete: 'SET NULL',
  });
  BlogCategory.hasMany(BlogCategory, {
    as: 'blog_categories',
    foreignKey: 'parent_id',
    onDelete: 'SET NULL',
  });

  BlogPost.belongsTo(BlogUser, {
    as: 'author',
    foreignKey: 'author_id',
    onDelete: 'CASCADE',
  });
  BlogUser.hasMany(BlogPost, {
    as: 'author_blog_posts',
    foreignKey: 'author_id',
    onDelete: 'CASCADE',
  });

  BlogPost.belongsTo(BlogUser, {
    as: 'editor',
    foreignKey: 'editor_id',
    onDelete: 'SET NULL',
  });
  BlogUser.hasMany(BlogPost, {
    as: 'editor_blog_posts',
    foreignKey: 'editor_id',
    onDelete: 'SET NULL',
  });

  BlogPost.belongsTo(BlogCategory, {
    as: 'category',
    foreignKey: 'category_id',
    onDelete: 'RESTRICT',
  });
  BlogCategory.hasMany(BlogPost, {
    as: 'blog_posts',
    foreignKey: 'category_id',
    onDelete: 'RESTRICT',
  });

  BlogPost.belongsToMany(BlogTag, {
    as: 'tags',
    through: 'blog_post_tags',
    foreignKey: 'blog_post_id',
    otherKey: 'blog_tag_id',
    timestamps: false,
  });
  BlogTag.belongsToMany(BlogPost, {
    as: 'blog_posts',
    through: 'blog_post_tags',
    foreignKey: 'blog_tag_id',
    otherKey: 'blog_post_id',
    timestamps: false,
  });

  BlogProfile.belongsTo(BlogUser, {
    as: 'user',
    foreignKey: 'user_id',
    onDelete: 'CASCADE',
  });
  BlogUser.hasOne(BlogProfile, {
    as: 'blog_profile',
    foreignKey: 'user_id',
    onDelete: 'CASCADE',
  });

  return { BlogUser, BlogCategory, BlogTag, BlogPost, BlogProfile };
}

export type Models = ReturnType<typeof initModels>;
