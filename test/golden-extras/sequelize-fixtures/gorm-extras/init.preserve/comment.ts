import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class Comment extends Model<
  InferAttributes<Comment>,
  InferCreationAttributes<Comment>
> {
  declare id: CreationOptional<string>;
  declare body: string;
  declare ownerId: string;
  declare ownerType: string;

  static initModel(sequelize: Sequelize): typeof Comment {
    Comment.init(
      {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        body: { type: DataTypes.TEXT, allowNull: false },
        ownerId: { type: DataTypes.BIGINT, allowNull: false },
        ownerType: { type: DataTypes.STRING(30), allowNull: false },
      },
      {
        sequelize,
        modelName: 'Comment',
        tableName: 'comments',
        timestamps: false,
        underscored: true,
      }
    );
    return Comment;
  }
}
