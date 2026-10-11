import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
  Sequelize,
} from 'sequelize';

// The class style: `class X extends Model` with typed `declare` fields and `X.init(attributes, options)`,
// once at the top level and once from a static method (`this.init`).
export const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: ':memory:',
  logging: false,
});

export class Author extends Model<
  InferAttributes<Author>,
  InferCreationAttributes<Author>
> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare bio: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

Author.init(
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    name: { type: DataTypes.STRING(80), allowNull: false },
    bio: DataTypes.TEXT,
    // Declared by hand, so they stay nullable (Sequelize only adds the missing ones as NOT NULL).
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, modelName: 'Author', tableName: 'authors' }
);

export class Book extends Model<
  InferAttributes<Book>,
  InferCreationAttributes<Book>
> {
  declare id: CreationOptional<number>;
  declare title: string;
  declare isbn: string | null;
  declare pages: number;
  declare authorId: number;

  static initModel(connection: Sequelize): typeof Book {
    this.init(
      {
        id: {
          type: DataTypes.BIGINT,
          autoIncrement: true,
          primaryKey: true,
        },
        title: { type: DataTypes.STRING, allowNull: false },
        isbn: { type: DataTypes.STRING(13), unique: true },
        pages: { type: DataTypes.INTEGER, defaultValue: 0 },
        authorId: { type: DataTypes.INTEGER, allowNull: false },
      },
      {
        sequelize: connection,
        tableName: 'books',
        underscored: true,
        indexes: [{ fields: ['title'] }],
      }
    );
    return this;
  }
}

Book.initModel(sequelize);

Author.hasMany(Book, { as: 'books', foreignKey: 'authorId' });
Book.belongsTo(Author, {
  as: 'author',
  foreignKey: 'authorId',
  onDelete: 'CASCADE',
});
