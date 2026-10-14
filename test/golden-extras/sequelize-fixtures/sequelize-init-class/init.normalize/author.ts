import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Book } from './book.js';

export class Author extends Model<
  InferAttributes<Author>,
  InferCreationAttributes<Author>
> {
  declare id: CreationOptional<string>;
  declare name: string;
  declare bio: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date | null>;
  declare updatedAt: CreationOptional<Date | null>;

  declare books?: NonAttribute<Book[]>;

  static initModel(sequelize: Sequelize): typeof Author {
    Author.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        name: { type: DataTypes.STRING(80), allowNull: false },
        bio: DataTypes.TEXT,
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      {
        sequelize,
        modelName: 'Author',
        tableName: 'author',
        timestamps: true,
        underscored: true,
      }
    );
    return Author;
  }
}
